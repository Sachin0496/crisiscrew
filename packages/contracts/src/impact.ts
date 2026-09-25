import type { AffectedCustomer, CustomerRecoveryState, IncidentView, OutreachTrack, RecoveryAction, RecoveryStatus } from "./domain";
import type { CrisisState } from "./state";

/** Statuses after which an action needs nothing more: done, prepared (voice is off), or settled by a human. */
const SETTLED: readonly RecoveryStatus[] = ["done", "prepared", "declined"];

export function actionsFor(incident: Pick<IncidentView, "actions">, customerRef: string): RecoveryAction[] {
  return incident.actions.filter((a) => a.customerRef === customerRef);
}

/** The outreach track a customer belongs to: complained, not complained (silent), or unverified. */
export function outreachTrack(customer: Pick<AffectedCustomer, "confidence" | "complained">): OutreachTrack {
  if (customer.confidence !== "confirmed") return "unverified";
  return customer.complained ? "complained" : "not_complained";
}

/** Where one customer's recovery stands. Only confirmed customers can be recovered; the rest are "unverified". */
export function customerState(customer: Pick<AffectedCustomer, "confidence">, actions: RecoveryAction[]): CustomerRecoveryState {
  if (customer.confidence !== "confirmed") return "unverified";
  if (actions.some((a) => a.status === "failed")) return "attention";
  if (actions.some((a) => a.status === "awaiting_approval")) return "needs_human";
  if (actions.length > 0 && actions.every((a) => SETTLED.includes(a.status))) return "recovered";
  return "in_progress";
}

export type Coverage = {
  /** Customers with a failed or pending payment inside the incident window. */
  confirmed: number;
  /** Confirmed customers who wrote in. */
  complained: number;
  /** Confirmed customers who never contacted support. */
  silent: number;
  /** Complained, but no failed payment on record: never credited, and outside the ratio. */
  unverified: number;
  recovered: number;
  needsHuman: number;
  inProgress: number;
  attention: number;
  /** recovered / confirmed, or null before anyone is confirmed. */
  ratio: number | null;
  /** Every confirmed customer is recovered. */
  complete: boolean;
};

/** Recovery Coverage: confirmed customers with a completed or human-decided recovery, over all confirmed customers. */
export function recoveryCoverage(incident: Pick<IncidentView, "impact" | "actions">): Coverage {
  const customers = incident.impact?.customers ?? [];
  const counts = { recovered: 0, needs_human: 0, in_progress: 0, attention: 0, unverified: 0 };
  let complained = 0;
  for (const c of customers) {
    counts[customerState(c, actionsFor(incident, c.ref))] += 1;
    if (c.confidence === "confirmed" && c.complained) complained += 1;
  }
  const confirmed = customers.length - counts.unverified;
  return {
    confirmed,
    complained,
    silent: confirmed - complained,
    unverified: counts.unverified,
    recovered: counts.recovered,
    needsHuman: counts.needs_human,
    inProgress: counts.in_progress,
    attention: counts.attention,
    ratio: confirmed > 0 ? counts.recovered / confirmed : null,
    complete: confirmed > 0 && counts.recovered === confirmed,
  };
}

export type RecoveryMetrics = {
  /** From the first complaint in the incident to the incident opening. */
  complaintToIncidentSec: number | null;
  silentFound: number;
  /** Tickets linked to the incident beyond the first: handled as one incident instead of one by one. */
  duplicateTicketsAvoided: number;
  /** Proactive messages and voice calls actually delivered (prepared voice scripts don't count). */
  proactiveContacts: number;
  /** Confirmed customers whose recovery isn't complete yet. */
  unrecovered: number;
  spend: {
    /** Credits the agents issued within their authority. */
    issuedInr: number;
    /** Credits issued on a human's approval. */
    approvedInr: number;
    /** Credits waiting for a human decision. */
    awaitingInr: number;
  };
};

export function recoveryMetrics(state: Pick<CrisisState, "tickets" | "credits" | "approvals">, incident: IncidentView): RecoveryMetrics {
  const coverage = recoveryCoverage(incident);
  const received = incident.ticketIds.map((id) => state.tickets[id]?.ticket.receivedAt).filter((t): t is number => t !== undefined);
  const credits = state.credits.filter((c) => c.incidentId === incident.id);
  const sum = (amounts: number[]) => amounts.reduce((a, b) => a + b, 0);
  return {
    complaintToIncidentSec: received.length > 0 ? Math.max(0, Math.round((incident.openedAt - Math.min(...received)) / 1000)) : null,
    silentFound: coverage.silent,
    duplicateTicketsAvoided: Math.max(0, new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size - 1),
    proactiveContacts: incident.updates.filter((u) => u.channel !== "ticket_reply" && u.status === "sent").length,
    unrecovered: coverage.confirmed - coverage.recovered,
    spend: {
      issuedInr: sum(credits.filter((c) => !c.approvalId).map((c) => c.amountInr)),
      approvedInr: sum(credits.filter((c) => c.approvalId).map((c) => c.amountInr)),
      awaitingInr: sum(Object.values(state.approvals).filter((a) => a.incidentId === incident.id && a.status === "pending").map((a) => a.amountInr)),
    },
  };
}

export type ImpactNodeKind = "incident" | "cause" | "service" | "window" | "customer" | "attempt" | "ticket" | "action";
export type ImpactGraph = {
  nodes: { id: string; kind: ImpactNodeKind; label: string; at?: number }[];
  edges: { from: string; to: string; kind: string; label: string }[];
};

const NODE_KIND: Record<string, ImpactNodeKind> = { cause: "cause", service: "service", window: "window", attempt: "attempt", ticket: "ticket" };

/**
 * The Customer Impact Graph as nodes and edges: the incident and its cause,
 * each affected customer, the evidence that links them (payment attempts,
 * tickets, the service, the window), and each recovery action. Absences
 * ("never contacted support") stay in the customer's evidence chain but
 * are not edges.
 */
export function impactGraph(incident: IncidentView): ImpactGraph {
  const nodes = new Map<string, ImpactGraph["nodes"][number]>();
  const edges: ImpactGraph["edges"] = [];
  const incidentNode = `incident:${incident.id}`;
  nodes.set(incidentNode, { id: incidentNode, kind: "incident", label: incident.id, at: incident.openedAt });
  if (incident.rootCause) {
    const cause = `cause:${incident.rootCause.hypothesisId}`;
    nodes.set(cause, { id: cause, kind: "cause", label: incident.rootCause.label });
    edges.push({ from: incidentNode, to: cause, kind: "caused_by", label: `${Math.round(incident.rootCause.confidence * 100)}% confidence` });
  }
  for (const c of incident.impact?.customers ?? []) {
    const customer = `customer:${c.ref}`;
    nodes.set(customer, { id: customer, kind: "customer", label: c.name });
    edges.push({ from: customer, to: incidentNode, kind: c.confidence === "confirmed" ? "affected_by" : "reported_during", label: c.confidence });
    for (const e of c.evidence) {
      const kind = NODE_KIND[e.node.split(":")[0] ?? ""];
      if (!kind) continue;
      if (!nodes.has(e.node)) nodes.set(e.node, { id: e.node, kind, label: kind === "service" ? e.node.slice("service:".length) : e.label, ...(e.at !== undefined ? { at: e.at } : {}) });
      edges.push({ from: customer, to: e.node, kind: e.kind, label: e.label });
    }
    for (const a of actionsFor(incident, c.ref)) {
      const action = `action:${a.id}`;
      nodes.set(action, { id: action, kind: "action", label: a.kind, at: a.updatedAt });
      edges.push({ from: customer, to: action, kind: "recovery", label: `${a.kind}: ${a.status}` });
    }
  }
  return { nodes: [...nodes.values()], edges };
}
