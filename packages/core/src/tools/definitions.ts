import {
  Surface,
  type Approval,
  type CrisisState,
  type CustomerUpdate,
  type EventInput,
  type IncidentView,
  type Level,
  type Policy,
  type Ticket,
  type ToolName,
} from "@crisiscrew/contracts";
import { z } from "zod";
import type { ToolDef } from "../policy/gate";
import type { Ports } from "../ports";
import { caseSummary, draftUpdate, type Draft } from "../recovery/templates";

export type ToolCtx = {
  now(): number;
  state(): CrisisState;
  ports: Ports;
  policy: Policy;
  emit(event: EventInput): void;
  drafts: Map<string, { draft: Draft; since: number }>;
  nextId(kind: "update" | "approval"): string;
  /** Approvals already used for a credit, so one approval can't pay twice. */
  spentApprovals: Set<string>;
};

type Tool = ToolDef<ToolCtx> & { name: ToolName };

function incidentOf(ctx: ToolCtx, id: string): IncidentView {
  const incident = ctx.state().incidents[id];
  if (!incident) throw new Error(`no incident ${id}`);
  return incident;
}

function ticketsOf(ctx: ToolCtx, incident: IncidentView): Ticket[] {
  const ids = new Set([...incident.ticketIds, ...incident.linkedTicketIds]);
  return [...ids].map((id) => ctx.state().tickets[id]?.ticket).filter((t): t is Ticket => Boolean(t));
}

function firstComplaintAt(ctx: ToolCtx, incident: IncidentView): number {
  return Math.min(...ticketsOf(ctx, incident).map((t) => t.receivedAt));
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
          }));
      },
      summarize: (r) => `${(r as unknown[]).length} tickets`,
    },
    {
      name: "get_incident",
      description: "Summary of an incident (the latest one when no id is given): status, root cause, affected customers, credit and approval.",
      input: z.object({ incidentId: z.string().optional() }),
      level: fixed(0),
      async run(args, ctx) {
        const s = ctx.state();
        const id = (args as { incidentId?: string }).incidentId ?? s.incidentOrder.at(-1);
        if (!id) return { incident: null };
        const i = incidentOf(ctx, id);
        const approval = i.approvalId ? s.approvals[i.approvalId] : undefined;
        return {
          id: i.id,
          status: i.status,
          severity: i.severity,
          surface: i.surface,
          openedAt: new Date(i.openedAt).toISOString(),
          linkedTickets: i.linkedTicketIds.length,
          rootCause: i.rootCause ?? null,
          affected: i.affected ? { total: i.affected.total, contactedUs: i.affected.ticketed.length, silent: i.affected.silent.length } : null,
          updatesSent: i.updates.filter((u) => u.status === "sent").length,
          credit: i.credit ?? null,
          approval: approval ? { id: approval.id, status: approval.status, amountInr: approval.amountInr } : null,
        };
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
      name: "identify_affected_customers",
      description: "Customers with failed or pending payments since a time, split into those who contacted us and those who haven't.",
      input: z.object({ incidentId: z.string().min(1), sinceMs: z.number().int().optional() }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.orders.adapter,
      async run(args, ctx) {
        const { incidentId, sinceMs } = args as { incidentId: string; sinceMs?: number };
        const incident = incidentOf(ctx, incidentId);
        const since = sinceMs ?? firstComplaintAt(ctx, incident) - ctx.policy.recovery.affectedLookbackMin * 60_000;
        const attempts = await ctx.ports.orders.attemptsSince(since);
        const ticketed = [...new Set(ticketsOf(ctx, incident).map((t) => t.customerRef))];
        const failing = new Set(attempts.filter((a) => a.status !== "success").map((a) => a.customerRef));
        const silent = [...failing].filter((ref) => !ticketed.includes(ref));
        return { ticketed, silent, since };
      },
      summarize: (r) => {
        const { ticketed, silent } = r as { ticketed: string[]; silent: string[] };
        return `${ticketed.length + silent.length} affected: ${ticketed.length} contacted us, ${silent.length} silent`;
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
          updates: [],
          timeline: [{ at: now, status: "detected", note: `${a.ticketIds.length} similar failure reports passed every detection gate` }],
        };
        ctx.emit({ type: "incident.opened", payload: { incident } });
        return { incidentId: a.incidentId };
      },
    },
    {
      name: "link_ticket_to_incident",
      description: "Link a ticket to an incident and leave a private note on it.",
      input: z.object({ incidentId: z.string().min(1), ticketId: z.string().min(1) }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.ticketActions.adapter,
      condition: (args, ctx) => {
        const { incidentId, ticketId } = args as { incidentId: string; ticketId: string };
        if (!ctx.state().incidents[incidentId]) return `no incident ${incidentId}`;
        return ctx.state().tickets[ticketId] ? null : `no ticket ${ticketId}`;
      },
      async run(args, ctx) {
        const { incidentId, ticketId } = args as { incidentId: string; ticketId: string };
        if (incidentOf(ctx, incidentId).linkedTicketIds.includes(ticketId)) return { linked: true, alreadyLinked: true };
        const ticket = ctx.state().tickets[ticketId]!.ticket;
        await ctx.ports.ticketActions.addNote(ticket, `Linked to ${incidentId} by CrisisCrew.`);
        ctx.emit({ type: "ticket.linked", payload: { incidentId, ticketId } });
        return { linked: true };
      },
    },
    {
      name: "draft_customer_update",
      description: "Write the one update every affected customer will receive for this incident.",
      input: idOnly,
      level: fixed(1),
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
        const since = root?.startedAt ?? firstComplaintAt(ctx, incident);
        const draft = draftUpdate(incident, since);
        ctx.drafts.set(incidentId, { draft, since });
        return draft;
      },
      summarize: (r) => (r as Draft).subject,
    },
    {
      name: "send_customer_update",
      description: "Send the incident update to one customer: a reply on their ticket, a proactive message (needs consent), or voice (needs voice consent).",
      input: z.object({
        incidentId: z.string().min(1),
        customerRef: z.string().min(1),
        channel: z.enum(["ticket_reply", "proactive_message", "voice"]),
        text: z.string().min(1).max(2000),
      }),
      level: fixed(2),
      adapter: (ctx) => ctx.ports.notifier.adapter,
      async condition(args, ctx) {
        const { incidentId, customerRef, channel } = args as { incidentId: string; customerRef: string; channel: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (channel === "ticket_reply") {
          return ticketsOf(ctx, incident).some((t) => t.customerRef === customerRef) ? null : "this customer has no ticket in the incident";
        }
        const customer = await ctx.ports.orders.customer(customerRef);
        if (!customer) return `unknown customer ${customerRef}`;
        if (channel === "proactive_message" && !customer.consent.proactive) return "customer has not agreed to proactive messages";
        if (channel === "voice" && !customer.consent.voice) return "customer has not agreed to voice contact";
        return null;
      },
      async run(args, ctx) {
        const { incidentId, customerRef, channel, text } = args as {
          incidentId: string;
          customerRef: string;
          channel: CustomerUpdate["channel"];
          text: string;
        };
        const incident = incidentOf(ctx, incidentId);
        const customer = await ctx.ports.orders.customer(customerRef);
        const ticket = ticketsOf(ctx, incident).find((t) => t.customerRef === customerRef);
        const name = customer?.name ?? ticket?.customerName ?? customerRef;
        let adapter: string;
        let status: CustomerUpdate["status"] = "sent";
        let audioId: string | null | undefined;
        if (channel === "ticket_reply") {
          await ctx.ports.ticketActions.reply(ticket!, text);
          adapter = ctx.ports.ticketActions.adapter;
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
        };
        ctx.emit({ type: "update.sent", payload: { update } });
        return { updateId: update.id, status };
      },
    },
    {
      name: "propose_recovery_credit",
      description: "Propose a goodwill credit for every affected customer at the policy rate, and say whether it's within the agents' authority.",
      input: idOnly,
      level: fixed(1),
      condition: (args, ctx) => (ctx.state().incidents[(args as { incidentId: string }).incidentId]?.affected ? null : "affected customers not identified yet"),
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const customers = incident.affected!.total;
        const perCustomerInr = ctx.policy.limits.creditPerCustomerInr;
        const amountInr = customers * perCustomerInr;
        const withinAuthority = amountInr <= ctx.policy.limits.authorityLimitInr;
        ctx.emit({ type: "credit.proposed", payload: { incidentId, amountInr, perCustomerInr, customers, withinAuthority } });
        return { amountInr, perCustomerInr, customers, withinAuthority };
      },
    },
    {
      name: "request_human_approval",
      description: "Ask a human to approve a proposed credit that exceeds the agents' authority, with the full case attached.",
      input: idOnly,
      level: fixed(1),
      condition(args, ctx) {
        const incident = ctx.state().incidents[(args as { incidentId: string }).incidentId];
        if (!incident?.credit) return "no credit has been proposed";
        if (incident.approvalId && ctx.state().approvals[incident.approvalId]?.status === "pending") return "an approval is already pending";
        return null;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const credit = incident.credit!;
        const limitInr = ctx.policy.limits.authorityLimitInr;
        const approval: Approval = {
          id: ctx.nextId("approval"),
          incidentId,
          action: "issue_recovery_credit",
          amountInr: credit.amountInr,
          limitInr,
          perCustomerInr: credit.perCustomerInr,
          customers: credit.customers,
          rationale: `The proposed credit exceeds the ${limitInr.toLocaleString("en-IN")} INR authority limit.`,
          caseSummary: caseSummary(incident, credit.amountInr, credit.perCustomerInr, limitInr),
          status: "pending",
          requestedAt: ctx.now(),
        };
        ctx.emit({ type: "approval.requested", payload: { approval } });
        return { approvalId: approval.id };
      },
    },
    {
      name: "issue_recovery_credit",
      description:
        "Issue the goodwill credit. Within the authority limit this needs L2; above it, L3 and an approved approval for exactly this amount.",
      input: z.object({ incidentId: z.string().min(1), amountInr: z.number().positive(), approvalId: z.string().optional() }),
      level: (args, ctx) => ((args as { amountInr: number }).amountInr <= ctx.policy.limits.authorityLimitInr ? 2 : 3),
      adapter: (ctx) => ctx.ports.credits.adapter,
      condition(args, ctx) {
        const { incidentId, amountInr, approvalId } = args as { incidentId: string; amountInr: number; approvalId?: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident?.credit) return "no credit has been proposed";
        if (incident.credit.status === "issued") return "a credit was already issued for this incident";
        if (approvalId !== undefined) {
          const approval = ctx.state().approvals[approvalId];
          if (!approval || approval.incidentId !== incidentId) return `no approval ${approvalId} for this incident`;
          if (approval.status !== "approved" && approval.status !== "modified") return `approval ${approvalId} is ${approval.status}`;
          if (ctx.spentApprovals.has(approvalId)) return `approval ${approvalId} was already used`;
          if (amountInr !== approval.approvedAmountInr) return `amount differs from the approved amount (${approval.approvedAmountInr} INR)`;
          return null;
        }
        if (amountInr > ctx.policy.limits.authorityLimitInr) return "needs an approved approval";
        return amountInr <= incident.credit.amountInr ? null : "amount exceeds the proposed credit";
      },
      async run(args, ctx) {
        const { incidentId, amountInr, approvalId } = args as { incidentId: string; amountInr: number; approvalId?: string };
        const incident = incidentOf(ctx, incidentId);
        const refs = [...(incident.affected?.ticketed ?? []), ...(incident.affected?.silent ?? [])];
        const { id } = await ctx.ports.credits.issue(refs, amountInr, incidentId);
        if (approvalId) ctx.spentApprovals.add(approvalId);
        ctx.emit({
          type: "credit.issued",
          payload: { incidentId, amountInr, adapter: ctx.ports.credits.adapter, creditId: id, ...(approvalId ? { approvalId } : {}) },
        });
        return { creditId: id, amountInr };
      },
    },
  ];
}
