import {
  actionsFor,
  customerState,
  outreachTrack,
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
  type ImportanceLevel,
  type IncidentView,
  type PageAttempt,
  type PagingView,
  type Level,
  type Policy,
  type Ticket,
  type ToolName,
} from "@crisiscrew/contracts";
import { z } from "zod";
import { checkOutbound } from "../guard/outbound";
import type { ToolDef } from "../policy/gate";
import type { Deployment, InfraHealth, Ports, ProviderHealth } from "../ports";
import { assessImpact } from "../recovery/impact";
import { planRecovery } from "../recovery/plan";
import { callMenu, customerCase, draftUpdate, engineeringSummary, engineeringTicket, inr, pageScript, problemRecord, rollbackChange, type Draft } from "../recovery/templates";
import { pageDialog } from "../agents/dialog";
import { fixTools } from "./fix";

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
  /** This server's public URL, for links back from engineering records. */
  publicBaseUrl?: string;
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

/** When the first sign of the incident arrived: its first complaint, or its first alert. */
function firstComplaintAt(ctx: ToolCtx, incident: IncidentView): number {
  const alerts = (incident.alertIds ?? []).map((id) => ctx.state().alerts[id]?.firedAt ?? Number.POSITIVE_INFINITY);
  const first = Math.min(...ticketsOf(ctx, incident).map((t) => t.receivedAt), ...alerts);
  return Number.isFinite(first) ? first : incident.openedAt;
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
    track: outreachTrack(c),
    severity: c.severity ?? null,
    tier: c.tier,
    recovery: customerState(c, actions),
    evidence: c.evidence.map((e) => e.label),
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      ...(a.track ? { track: a.track } : {}),
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
          importance: i.importance ? { level: i.importance.level, page: i.importance.page, reasons: i.importance.reasons.map((r) => r.text), by: i.importance.by ?? null } : null,
          surface: i.surface,
          openedAt: new Date(i.openedAt).toISOString(),
          linkedTickets: i.linkedTicketIds.length,
          rootCause: i.rootCause ?? null,
          impact: i.impact ? { affected: coverage.confirmed, complained: coverage.complained, silent: coverage.silent, unverified: coverage.unverified } : null,
          recoveryCoverage: coverage.confirmed ? { recovered: coverage.recovered, of: coverage.confirmed, needsHuman: coverage.needsHuman } : null,
          pendingDecisions: pending.map((a) => ({ id: a.id, customer: a.customerName, amountInr: a.amountInr })),
          engineeringIncident: i.engineering ?? null,
          onCall: i.paging
            ? { status: i.paging.status, acknowledgedBy: i.paging.acknowledgedBy ?? null, attempts: i.paging.attempts.map((a) => ({ responder: a.responder, role: a.role, state: a.state })) }
            : null,
        };
      },
    },
    {
      name: "get_customer_impact",
      description:
        "The Customer Impact Graph for an incident (the latest when no id is given): every affected customer, their outreach track (complained, not complained, or unverified), the evidence that links them to the incident, and their recovery actions and state.",
      input: z.object({
        incidentId: z.string().optional(),
        /** complained and silent are the Handoff Agent's two outreach tracks; not_complained is the same as silent. */
        filter: z.enum(["all", "complained", "silent", "not_complained", "needs_human", "unverified"]).default("all"),
      }),
      level: fixed(0),
      async run(args, ctx) {
        const { incidentId, filter } = args as { incidentId?: string; filter: string };
        const i = incidentOrLatest(ctx, incidentId);
        if (!i) return { incident: null, customers: [] };
        const customers = (i.impact?.customers ?? []).map((c) => customerView(i, c));
        const shown = customers.filter((c) => {
          if (filter === "complained") return c.confidence === "confirmed" && c.complained;
          if (filter === "silent" || filter === "not_complained") return c.confidence === "confirmed" && !c.complained;
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
      untrusted: (r) => (r as ProviderHealth[]).flatMap((p) => [p.detail, ...p.components.map((c) => `${c.name}: ${c.status}`)]),
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
      untrusted: (r) => (r as Deployment[]).map((d) => d.message),
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
      name: "get_infra_health",
      description:
        "A service's infrastructure now: its pods (ready, restarts, CrashLoopBackOff) from Kubernetes, its cloud alarms (CloudWatch) over the last N minutes, and its CPU. A part no source could check is reported as not checked.",
      input: z.object({ service: z.string().min(1), minutes: z.number().int().min(5).max(1440).default(120) }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.infra.adapter,
      async run(args, ctx) {
        const { service, minutes } = args as { service: string; minutes: number };
        return ctx.ports.infra.health(service, ctx.now() - minutes * 60_000);
      },
      summarize: (r) => {
        const h = r as InfraHealth;
        const pods = h.pods ? `${h.pods.ready}/${h.pods.total} pods ready${h.pods.crashLooping ? `, ${h.pods.crashLooping} crash-looping` : ""}` : "pods not checked";
        const alarms = h.alarms ? `${h.alarms.length} ${h.alarms.length === 1 ? "alarm" : "alarms"}` : "alarms not checked";
        return `${h.service}: ${pods}; ${alarms}`;
      },
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
        // A failed payment is evidence of harm only when payments are what's failing: a delivery or login incident is judged on its complaints.
        const attempts = incident.surface === "checkout_payments" ? await ctx.ports.orders.attemptsSince(since) : [];
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
      input: z
        .object({
          incidentId: z.string().min(1),
          clusterId: z.string().min(1),
          ticketIds: z.array(z.string()),
          surface: Surface,
          importance: z.enum(["P1", "P2", "P3"]),
          /** An alert-triggered incident starts from its alert, with no tickets yet. */
          alertId: z.string().optional(),
        })
        .refine((a) => a.ticketIds.length > 0 || a.alertId !== undefined, { message: "an incident needs failure reports or an alert", path: ["ticketIds"] }),
      level: fixed(1),
      condition: (args, ctx) => {
        const { incidentId, alertId } = args as { incidentId: string; alertId?: string };
        if (ctx.state().incidents[incidentId]) return "incident is already open";
        if (alertId && !ctx.state().alerts[alertId]) return `no alert ${alertId}`;
        return null;
      },
      async run(args, ctx) {
        const a = args as { incidentId: string; clusterId: string; ticketIds: string[]; surface: Surface; importance: ImportanceLevel; alertId?: string };
        const alert = a.alertId ? ctx.state().alerts[a.alertId] : undefined;
        const now = ctx.now();
        const incident: IncidentView = {
          id: a.incidentId,
          status: "detected",
          severity: a.importance === "P1" ? "high" : "medium",
          openedAt: now,
          surface: a.surface,
          clusterId: a.clusterId,
          ticketIds: a.ticketIds,
          linkedTicketIds: [],
          hypotheses: [],
          actions: [],
          updates: [],
          trigger: alert ? "alert" : "complaints",
          timeline: [
            {
              at: now,
              status: "detected",
              note: alert ? `Critical alert on ${alert.service}: ${alert.label}` : `${a.ticketIds.length} similar failure reports passed every detection gate`,
            },
          ],
        };
        ctx.emit({ type: "incident.opened", payload: { incident } });
        if (alert) ctx.emit({ type: "alert.linked", payload: { alertId: alert.id, incidentId: a.incidentId } });
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
        const importance = incident.importance?.level ?? (incident.severity === "high" ? "P1" : "P2");
        const alert = incident.trigger === "alert" ? ctx.state().alerts[incident.alertIds?.[0] ?? ""] : undefined;
        const base = ctx.publicBaseUrl?.replace(/\/+$/, "");
        const record = await ctx.ports.incidents.open({
          incidentId,
          importance,
          service: ctx.ports.catalog.servicesFor(incident.surface)[0]?.name,
          tags: ["crisiscrew", incident.surface],
          ...engineeringTicket(incident, { ...(alert ? { alert } : {}), ...(incident.paging ? { paging: incident.paging } : {}), ...(base ? { links: { incident: `${base}/#/incident`, audit: `${base}/api/audit` } } : {}) }),
        });
        ctx.emit({ type: "engineering.recorded", payload: { incidentId, record: { ...record, adapter: ctx.ports.incidents.adapter, importance } } });
        return record;
      },
      summarize: (r) => `filed ${(r as { id: string }).id}`,
    },
    {
      name: "request_rollback_change",
      description:
        "Request a rollback of the release blamed for the incident, as a change record linked to the engineering incident, for engineering to plan and approve. Only when a release is the likely cause with high confidence.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.incidents.adapter,
      condition(args, ctx) {
        const incident = ctx.state().incidents[(args as { incidentId: string }).incidentId];
        if (!incident) return "no such incident";
        if (!incident.engineering) return "no engineering incident has been filed";
        if (incident.engineering.change) return `already requested as ${incident.engineering.change.id}`;
        const top = incident.hypotheses[0];
        if (top?.kind !== "deploy" || incident.rootCause?.hypothesisId !== top.id) return "no release is the likely cause";
        return top.confidence >= ctx.policy.issues.rollbackConfidence ? null : `${top.label} is only ${Math.round(top.confidence * 100)}% likely; a rollback needs ${Math.round(ctx.policy.issues.rollbackConfidence * 100)}%`;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const record = incident.engineering!;
        const top = incident.hypotheses[0]!;
        const change = await ctx.ports.incidents.requestChange(record.id, {
          ...rollbackChange(incident),
          importance: incident.importance?.level ?? "P2",
          service: top.subject.split("@")[0],
        });
        ctx.emit({ type: "engineering.recorded", payload: { incidentId, record: { ...record, change } } });
        return change;
      },
      summarize: (r) => `rollback change ${(r as { id: string }).id} requested`,
    },
    {
      name: "open_problem_record",
      description: "Open a problem record for the post-incident review once the incident is recovered, linked to the engineering incident.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.incidents.adapter,
      condition(args, ctx) {
        const incident = ctx.state().incidents[(args as { incidentId: string }).incidentId];
        if (!incident) return "no such incident";
        if (!incident.engineering) return "no engineering incident has been filed";
        if (incident.engineering.problem) return `already opened as ${incident.engineering.problem.id}`;
        return incident.status === "recovered" ? null : "the incident isn't recovered yet";
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const record = incident.engineering!;
        const problem = await ctx.ports.incidents.openProblem(record.id, {
          ...problemRecord(incident, recoveryCoverage(incident)),
          importance: incident.importance?.level ?? "P2",
          service: ctx.ports.catalog.servicesFor(incident.surface)[0]?.name,
        });
        ctx.emit({ type: "engineering.recorded", payload: { incidentId, record: { ...record, problem } } });
        return problem;
      },
      summarize: (r) => `problem ${(r as { id: string }).id} opened for the post-incident review`,
    },
    {
      name: "update_engineering_incident",
      description:
        "Add a private note to the engineering incident: the root cause, customer impact and recovery coverage, or a change of importance (which also sets its priority).",
      input: z.object({ incidentId: z.string().min(1), note: z.string().min(1).max(4000), importance: z.enum(["P1", "P2", "P3"]).optional() }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.incidents.adapter,
      condition: (args, ctx) => (ctx.state().incidents[(args as { incidentId: string }).incidentId]?.engineering ? null : "no engineering incident has been filed"),
      async run(args, ctx) {
        const { incidentId, note, importance } = args as { incidentId: string; note: string; importance?: ImportanceLevel };
        const record = incidentOf(ctx, incidentId).engineering!;
        if (importance && importance !== record.importance) {
          await ctx.ports.incidents.setImportance(record.id, importance);
          ctx.emit({ type: "engineering.recorded", payload: { incidentId, record: { ...record, importance } } });
        }
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
        if (channel === "voice") return ctx.ports.telephony.adapter;
        if (channel !== "ticket_reply") return ctx.ports.notifier.adapter;
        const incident = incidentId ? ctx.state().incidents[incidentId] : undefined;
        const ticket = incident ? ticketsOf(ctx, incident).filter((t) => t.customerRef === customerRef).at(-1) : undefined;
        return ticketAdapter(ctx, ticket?.id);
      },
      async condition(args, ctx) {
        const { incidentId, customerRef, channel } = args as { incidentId: string; customerRef: string; channel: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (channel === "ticket_reply" && !ticketsOf(ctx, incident).some((t) => t.customerRef === customerRef)) return "this customer has no ticket in the incident";
        if (channel !== "ticket_reply" && affectedCustomer(incident, customerRef)?.confidence !== "confirmed") return "no evidence this customer was affected, so they aren't contacted";
        const customer = await ctx.ports.orders.customer(customerRef);
        if (!customer && channel !== "ticket_reply") return `unknown customer ${customerRef}`;
        if (channel === "proactive_message" && !customer?.consent.proactive) return "customer has not agreed to proactive messages";
        if (channel === "voice" && !customer?.consent.voice) return "customer has not agreed to voice contact";
        if (channel === "voice") {
          const refusal = callGuardrails(ctx, incident, customerRef, (args as { text: string }).text);
          if (refusal) return refusal;
        }
        const text = (args as { text: string }).text;
        const approvals = Object.values(ctx.state().approvals).filter((a) => a.incidentId === incidentId && a.customerRef === customerRef);
        const refusal = checkOutbound(text, {
          allowedAmountsInr: [
            ...incident.actions.filter((a) => a.customerRef === customerRef && a.kind === "credit").flatMap((a) => a.amountInr === undefined ? [] : [a.amountInr]),
            ...approvals.flatMap((a) => a.approvedAmountInr === undefined ? [] : [a.approvedAmountInr]),
          ],
          allowedPaymentAmountsInr: [affectedCustomer(incident, customerRef)?.amountInr ?? 0],
          allowedHosts: ctx.policy.guardrails.allowedLinkHosts,
          ownContacts: [customer?.email, customer?.phone].filter((c): c is string => Boolean(c)),
        });
        return refusal ? `output guard: ${refusal}` : null;
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
        let callId: string | undefined;
        if (channel === "ticket_reply") {
          await ctx.ports.ticketActions.reply(ticket!, text);
          adapter = ticketAdapter(ctx, ticket!.id);
        } else if (channel === "proactive_message") {
          await ctx.ports.notifier.proactive(customer!, text);
          adapter = ctx.ports.notifier.adapter;
        } else if (customer?.phone) {
          // A real call: the script, then a bounded menu whose replies come from what CrisisCrew knows.
          const credit = incident.actions.find((a) => a.customerRef === customerRef && a.kind === "credit");
          ({ callId } = await ctx.ports.telephony.call({
            to: customer.phone,
            script: text,
            purpose: "customer",
            gather: callMenu(affectedCustomer(incident, customerRef)!, credit),
            metadata: { incidentId, customerRef, ...(actionId ? { actionId } : {}) },
          }));
          adapter = ctx.ports.telephony.adapter;
          status = "calling";
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
          ...(channel === "voice" && !callId ? { audioId: audioId ?? null } : {}),
          ...(callId ? { callId } : {}),
          ...(actionId ? { actionId } : {}),
        };
        ctx.emit({ type: "update.sent", payload: { update } });
        return { updateId: update.id, customer: name, channel, status, adapter, ...(callId ? { callId } : {}) };
      },
      summarize: (r) => {
        const { updateId, customer, channel, status } = r as { updateId: string; customer: string; channel: string; status: string };
        const how = channel === "ticket_reply" ? "ticket reply" : channel === "proactive_message" ? "proactive message" : "voice script";
        if (status === "calling") return `calling ${customer} (${updateId}, ${(r as { callId?: string }).callId})`;
        return `${how} to ${customer} ${status === "prepared" ? "prepared (voice is off)" : "sent"} (${updateId})`;
      },
    },
    {
      name: "record_contact_preference",
      description: "Record that a customer no longer wants to be contacted this way (for example, they pressed 3 on a call: stop calling me).",
      input: z.object({ incidentId: z.string().min(1), customerRef: z.string().min(1), channel: z.enum(["voice", "proactive"]) }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.orders.adapter,
      async condition(args, ctx) {
        const { customerRef } = args as { customerRef: string };
        return (await ctx.ports.orders.customer(customerRef)) ? null : `unknown customer ${customerRef}`;
      },
      async run(args, ctx) {
        const { customerRef, channel } = args as { customerRef: string; channel: "voice" | "proactive" };
        await ctx.ports.orders.withdrawConsent(customerRef, channel);
        return { customerRef, channel, consent: false };
      },
      summarize: (r) => `${(r as { customerRef: string }).customerRef} opted out of ${(r as { channel: string }).channel === "voice" ? "calls" : "proactive messages"}`,
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
    {
      name: "page_on_call",
      description:
        "Phone the on-call engineer for an important incident and ask them to press 1 to acknowledge. Attempt 1 calls the primary responder; each later attempt escalates to the next one on the schedule.",
      input: z.object({ incidentId: z.string().min(1), attempt: z.number().int().min(1) }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.telephony.adapter,
      condition(args, ctx) {
        const { incidentId, attempt } = args as { incidentId: string; attempt: number };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (!incident.importance?.page) return `${incidentId} is ${incident.importance?.level ?? "not assessed"}, below the level that pages on-call`;
        const paging = incident.paging;
        if (paging?.status === "acknowledged") return `already acknowledged by ${paging.acknowledgedBy}`;
        const made = paging?.attempts.length ?? 0;
        if (attempt !== made + 1) return attempt <= made ? `attempt ${attempt} was already made` : `attempt ${made + 1} comes first`;
        if (paging?.attempts.at(-1)?.state === "calling") return `attempt ${made} is still in progress`;
        const max = ctx.policy.oncall.maxEscalations + 1;
        return attempt > max ? `no escalations left: ${max} ${max === 1 ? "responder was" : "responders were"} already paged` : null;
      },
      async run(args, ctx) {
        const { incidentId, attempt } = args as { incidentId: string; attempt: number };
        const incident = incidentOf(ctx, incidentId);
        const service = ctx.ports.catalog.servicesFor(incident.surface)[0]?.name ?? incident.surface;
        const responders = (await ctx.ports.oncall.whoIsOnCall(service)).filter((r) => r.phone);
        const responder = responders[attempt - 1];
        const attempts = incident.paging?.attempts ?? [];
        if (!responder) {
          const status = attempt === 1 ? "no_responder" : "exhausted";
          const note = attempt === 1 ? `Nobody on call for ${service} has a phone number` : `Nobody left on call for ${service} to escalate to`;
          ctx.emit({ type: "paging.updated", payload: { incidentId, paging: { status, attempts, note } } });
          return { paged: false, reason: note };
        }
        const now = ctx.now();
        const masked = `••••${responder.phone!.replace(/\D/g, "").slice(-4)}`;
        const entry: PageAttempt = { attempt, responder: responder.name, role: responder.role, phone: masked, state: "calling", startedAt: now, updatedAt: now };
        // Recorded before dialling, so the call's first updates always find their attempt.
        ctx.emit({ type: "paging.updated", payload: { incidentId, paging: { status: "paging", attempts: [...attempts, entry] } } });
        let callId: string;
        try {
          ({ callId } = await ctx.ports.telephony.call({
            to: responder.phone!,
            script: pageScript(incident, responder.name),
            purpose: "oncall",
            gather: { prompt: "Say acknowledge, or press 1, to take this incident." },
            metadata: { incidentId, attempt: String(attempt) },
            dialog: pageDialog(ctx.state, incidentId, responder.name),
          }));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          patchAttempt(ctx, incidentId, attempt, { state: "failed", reason });
          throw error;
        }
        patchAttempt(ctx, incidentId, attempt, { callId });
        return { callId, responder: responder.name, role: responder.role };
      },
      summarize: (r) => {
        const res = r as { paged?: false; reason?: string; responder?: string; role?: string; callId?: string };
        return res.paged === false ? `not paged: ${res.reason}` : `calling ${res.responder} (${res.role}), ${res.callId}`;
      },
    },
    ...(fixTools() as Tool[]),
  ];
}

const CALL_FINAL = ["completed", "no_answer", "busy", "failed"];

/** The hour of the day, 0 to 23, in a time zone. */
function hourIn(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(at));
}

/**
 * What may stop a call to a customer, beyond consent and evidence: the hour,
 * a call already out, a call already answered, the number of calls, and a
 * script that names a credit amount nobody has issued.
 */
function callGuardrails(ctx: ToolCtx, incident: IncidentView, customerRef: string, text: string): string | null {
  const { callingHours, maxAttempts } = ctx.policy.voice;
  const hour = hourIn(ctx.now(), callingHours.timeZone);
  if (hour < callingHours.start || hour >= callingHours.end) {
    return `outside calling hours (${String(callingHours.start).padStart(2, "0")}:00 to ${String(callingHours.end).padStart(2, "0")}:00, ${callingHours.timeZone})`;
  }
  const calls = Object.values(ctx.state().calls).filter((c) => c.purpose === "customer" && c.metadata?.incidentId === incident.id && c.metadata?.customerRef === customerRef);
  if (calls.some((c) => !CALL_FINAL.includes(c.state))) return "a call to this customer is already in progress";
  if (calls.some((c) => c.state === "completed")) return "this customer was already reached by phone about this incident";
  if (calls.length >= maxAttempts) return `already called ${calls.length} times, the most allowed`;
  // Only a credit that was actually issued may be named, and only at its amount.
  const issued = new Set(ctx.state().credits.filter((c) => c.incidentId === incident.id && c.customerRef === customerRef).map((c) => c.amountInr));
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!/credit/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/₹\s?([\d,]+)/g)) {
      if (!issued.has(Number(m[1]!.replace(/,/g, "")))) return "the call can't promise a credit amount that hasn't been issued";
    }
  }
  return null;
}

/** Changes one page attempt, leaving whatever else has happened to the paging since. */
export function patchAttempt(ctx: Pick<ToolCtx, "state" | "emit" | "now">, incidentId: string, attempt: number, change: Partial<PageAttempt>, paging?: Partial<PagingView>): void {
  const current = ctx.state().incidents[incidentId]?.paging;
  if (!current) return;
  const attempts = current.attempts.map((a) => (a.attempt === attempt ? { ...a, ...change, updatedAt: ctx.now() } : a));
  ctx.emit({ type: "paging.updated", payload: { incidentId, paging: { ...current, ...paging, attempts } } });
}
