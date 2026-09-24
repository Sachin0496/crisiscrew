import {
  PAYMENT_METHOD_LABELS,
  type AffectedCustomer,
  type Customer,
  type EvidenceEdge,
  type ImpactSeverity,
  type PaymentMethod,
  type Ticket,
} from "@crisiscrew/contracts";
import type { PaymentAttempt } from "../ports";
import { clockTime, clockTimeSec, inr } from "./templates";

export type ImpactInput = {
  incidentId: string;
  /** The incident's tickets: the failure reports it opened on, plus those linked later. */
  tickets: Ticket[];
  /** Payment attempts from the start of the window to now. */
  attempts: PaymentAttempt[];
  customers: Map<string, Customer>;
  since: number;
  /** The services behind the incident's product area. */
  services: string[];
  cause?: { id: string; label: string; confidence: number; startedAt?: number };
  highValueInr: number;
  /** Which adapter supplied the orders data, for each evidence edge. */
  ordersSource: string;
};

const FAILING = new Set(["failed", "pending"]);
const MAX_ATTEMPT_EDGES = 4;

function attemptEdge(ref: string, a: PaymentAttempt, source: string): EvidenceEdge {
  const what = `${PAYMENT_METHOD_LABELS[a.method]} payment of ${inr(a.amountInr)}`;
  return {
    kind: a.status === "failed" ? "payment_failed" : "payment_pending",
    label: a.status === "failed" ? `${what} failed at ${clockTimeSec(a.at)}` : `${what} stuck as pending at ${clockTimeSec(a.at)}`,
    node: `attempt:${ref}:${a.at}`,
    at: a.at,
    source,
  };
}

function quote(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

export function severityOf(c: Pick<AffectedCustomer, "tier" | "amountInr" | "paidOnRetry">, highValueInr: number): ImpactSeverity {
  if (c.paidOnRetry) return "low";
  if (c.tier === "priority" || c.amountInr >= highValueInr) return "high";
  return "medium";
}

/**
 * Builds the Customer Impact Graph for one incident. A customer is affected
 * when they have a failed or pending payment inside the incident window
 * (confirmed), or when they filed a failure report in the incident but no
 * such payment is on record (unverified). Ticket membership alone never
 * confirms harm. Each customer carries the evidence that links them to the
 * incident, one readable sentence per edge.
 */
export function assessImpact(input: ImpactInput): AffectedCustomer[] {
  const byCustomer = new Map<string, PaymentAttempt[]>();
  for (const a of [...input.attempts].sort((x, y) => x.at - y.at)) {
    if (a.at < input.since) continue;
    byCustomer.set(a.customerRef, [...(byCustomer.get(a.customerRef) ?? []), a]);
  }
  const ticketsBy = new Map<string, Ticket[]>();
  for (const t of [...input.tickets].sort((x, y) => x.receivedAt - y.receivedAt)) {
    ticketsBy.set(t.customerRef, [...(ticketsBy.get(t.customerRef) ?? []), t]);
  }
  const failingRefs = [...byCustomer].filter(([, list]) => list.some((a) => FAILING.has(a.status))).map(([ref]) => ref);
  const refs = [...new Set([...ticketsBy.keys(), ...failingRefs])];

  const window: EvidenceEdge = {
    kind: "window",
    label: `Inside the incident window: since ${clockTime(input.since)}${input.cause?.startedAt === input.since ? `, when ${input.cause.label} shipped` : ""}`,
    node: `window:${input.incidentId}`,
    source: "engine",
  };

  const customers = refs.map((ref): AffectedCustomer => {
    const record = input.customers.get(ref);
    const tickets = ticketsBy.get(ref) ?? [];
    const attempts = byCustomer.get(ref) ?? [];
    const failing = attempts.filter((a) => FAILING.has(a.status));
    const last = failing.at(-1);
    const retry = last ? attempts.find((a) => a.status === "success" && a.at > last.at) : undefined;
    const confirmed = failing.length > 0;
    const amountInr = failing.reduce((max, a) => Math.max(max, a.amountInr), 0);
    const methods = [...new Set(failing.map((a) => a.method))] as PaymentMethod[];

    const evidence: EvidenceEdge[] = failing.slice(-MAX_ATTEMPT_EDGES).map((a) => attemptEdge(ref, a, input.ordersSource));
    if (retry) {
      evidence.push({
        kind: "payment_succeeded",
        label: `Paid ${inr(retry.amountInr)} by ${PAYMENT_METHOD_LABELS[retry.method]} at ${clockTimeSec(retry.at)}, on a retry`,
        node: `attempt:${ref}:${retry.at}`,
        at: retry.at,
        source: input.ordersSource,
      });
    }
    if (confirmed) {
      for (const service of input.services) {
        evidence.push({ kind: "service", label: `Affected service: ${service}`, node: `service:${service}`, source: "engine" });
      }
      if (input.cause) {
        evidence.push({
          kind: "cause",
          label: `Likely cause: ${input.cause.label} (${Math.round(input.cause.confidence * 100)}%)`,
          node: `cause:${input.cause.id}`,
          source: "engine",
        });
      }
      evidence.push(window);
    } else {
      evidence.push({ kind: "no_payment", label: `No failed or pending payment on record since ${clockTime(input.since)}`, node: "none", source: input.ordersSource });
    }
    for (const t of tickets) {
      evidence.push({
        kind: "reported",
        label: `Opened ${t.id} at ${clockTimeSec(t.receivedAt)}: ${quote(t.body)}`,
        node: `ticket:${t.id}`,
        at: t.receivedAt,
        source: t.source,
      });
    }
    if (tickets.length === 0) evidence.push({ kind: "no_ticket", label: "Never contacted support", node: "none", source: "engine" });

    const base = {
      ref,
      name: record?.name ?? tickets[0]?.customerName ?? ref,
      ...(record?.email ? { email: record.email } : {}),
      tier: record?.tier ?? "standard",
      consent: { proactive: record?.consent.proactive ?? false, voice: record?.consent.voice ?? false },
      complained: tickets.length > 0,
      ticketIds: tickets.map((t) => t.id),
      confidence: confirmed ? "confirmed" : "unverified",
      failedAttempts: failing.length,
      amountInr,
      methods,
      ...(failing[0] ? { firstFailedAt: failing[0].at } : {}),
      ...(last ? { lastFailedAt: last.at } : {}),
      paidOnRetry: Boolean(retry),
      evidence,
    } satisfies Omit<AffectedCustomer, "severity">;
    return confirmed ? { ...base, severity: severityOf(base, input.highValueInr) } : base;
  });

  // Complained first (by their first ticket), then silent (by their first failure), then unverified.
  const rank = (c: AffectedCustomer) => (c.confidence !== "confirmed" ? 2 : c.complained ? 0 : 1);
  const time = (c: AffectedCustomer) => (c.complained ? (ticketsBy.get(c.ref)?.[0]?.receivedAt ?? 0) : (c.firstFailedAt ?? 0));
  return customers.sort((a, b) => rank(a) - rank(b) || time(a) - time(b) || a.ref.localeCompare(b.ref));
}
