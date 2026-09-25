import {
  actionsFor,
  customerState,
  incidentTitle as titleFor,
  type AffectedCustomer,
  type Approval,
  type ClusterView,
  type CrisisState,
  type CustomerRecoveryState,
  type IncidentStatus,
  type IncidentView,
  type RecoveryAction,
  type Scenario,
} from "@crisiscrew/contracts";
import { inr, RECOVERY_CHIP, type Tone } from "./format";

/** The most recently opened incident, if there is one. */
export function currentIncident(state: CrisisState): IncidentView | undefined {
  const id = state.incidentOrder.at(-1);
  return id ? state.incidents[id] : undefined;
}

/** The session chip in the top bar. */
export function sessionSummary(state: CrisisState): { label: string; tone: Tone } {
  const { session } = state;
  if (session.mode === "replay") {
    return state.replayFinished ? { label: "Replay finished", tone: "neutral" } : { label: `Replaying at ${session.speed ?? 1}×`, tone: "accent" };
  }
  if (session.mode === "live") return { label: "Live session", tone: "success" };
  return { label: "Connecting", tone: "neutral" };
}

const GATE_WORDS = { size: "size", cohesion: "similarity", failure_share: "failure share", burst: "burst" } as const;

function joinList(parts: string[]): string {
  if (parts.length < 3) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** What a replayed scenario should do, as its labels say. */
export function expectedOutcome(expected: Scenario["expected"]): string {
  if (!expected.incident) return `Expected: no incident${expected.refusedBy ? `, refused by the ${GATE_WORDS[expected.refusedBy]} gate` : ""}`;
  const cause = expected.rootCause?.split(":")[1];
  const parts = [`an incident${cause ? ` caused by ${cause}` : ""}`];
  if (expected.affected !== undefined) parts.push(`${expected.affected} customers harmed${expected.silent !== undefined ? ` (${expected.silent} silent)` : ""}`);
  if (expected.importance) parts.push(`importance ${expected.importance}${expected.pages ? ", page on-call" : ""}`);
  if (expected.needsHuman) parts.push(`${expected.needsHuman === 1 ? "one credit" : `${expected.needsHuman} credits`} for a human to decide`);
  return `Expected: ${joinList(parts)}`;
}

/** An incident's headline, named after the product area that is failing. */
export const incidentTitle = titleFor;

export type StepState = "done" | "current" | "upcoming";
export type ProgressStep = { key: IncidentStatus; label: string; state: StepState; at?: number };

const STEPS: { key: IncidentStatus; label: string }[] = [
  { key: "detected", label: "Detected" },
  { key: "investigating", label: "Investigating" },
  { key: "root_cause_identified", label: "Root cause" },
  { key: "recovering", label: "Recovering" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "recovered", label: "Recovered" },
];

/**
 * The incident's progress for the stepper. The approval step only appears
 * once a human decision has been asked for; recovery within authority never
 * needs one.
 */
export function progressSteps(incident: Pick<IncidentView, "status" | "timeline">): ProgressStep[] {
  const needsHuman = incident.status === "awaiting_approval" || incident.timeline.some((t) => t.status === "awaiting_approval");
  const steps = STEPS.filter((s) => s.key !== "awaiting_approval" || needsHuman);
  const finished = incident.status === "recovered" || incident.status === "resolved";
  const current = steps.findIndex((s) => s.key === incident.status);
  return steps.map((step, i) => {
    const at = incident.timeline.find((t) => t.status === step.key)?.at;
    const state: StepState = finished || (current >= 0 && i < current) ? "done" : i === current ? "current" : "upcoming";
    return { ...step, state, ...(at !== undefined && state !== "upcoming" ? { at } : {}) };
  });
}

export type Verdict = { tone: "opened" | "joined" | "refused"; text: string };

/** One line on what the Pattern Agent decided about the latest group of tickets. */
export function groupVerdict(group: ClusterView, incidents: CrisisState["incidents"]): Verdict {
  if (!group.incidentId) {
    const failing = group.gates.find((g) => !g.pass);
    return { tone: "refused", text: `No incident: ${failing?.reason ?? "not every gate passed"}` };
  }
  const opened = incidents[group.incidentId];
  if (opened && group.reportTicketIds.length > opened.ticketIds.length) {
    return { tone: "joined", text: `The latest complaint joined ${group.incidentId}, which now has ${group.reportTicketIds.length} tickets` };
  }
  return { tone: "opened", text: `All four gates passed, so ${group.incidentId} opened` };
}

export type CustomerFilter = "all" | "complained" | "silent" | "needs_human" | "unverified";

export type CustomerRow = {
  customer: AffectedCustomer;
  actions: RecoveryAction[];
  state: CustomerRecoveryState;
  /** The strongest piece of evidence, in a few words. */
  headline: string;
};

/** Every affected customer with their recovery state, in the order the impact graph lists them. */
export function customerRows(incident: IncidentView | undefined): CustomerRow[] {
  return (incident?.impact?.customers ?? []).map((customer) => {
    const actions = actionsFor(incident!, customer.ref);
    // The latest failure says most; a payment only stuck as pending comes next.
    const payment =
      customer.evidence.findLast((e) => e.kind === "payment_failed") ?? customer.evidence.findLast((e) => e.kind === "payment_pending");
    return { customer, actions, state: customerState(customer, actions), headline: payment?.label ?? "No failed payment on record" };
  });
}

export function matchesFilter(row: CustomerRow, filter: CustomerFilter): boolean {
  const confirmed = row.customer.confidence === "confirmed";
  if (filter === "complained") return confirmed && row.customer.complained;
  if (filter === "silent") return confirmed && !row.customer.complained;
  if (filter === "needs_human") return row.state === "needs_human";
  if (filter === "unverified") return !confirmed;
  return true;
}

/** A customer's recovery in a few words, e.g. "Message · Voice · ₹1,000 credit". */
export function planSummary(actions: RecoveryAction[]): string {
  return actions
    .filter((a) => a.kind !== "no_credit")
    .map((a) => (a.kind === "credit" ? `${inr(a.amountInr ?? 0)} credit` : RECOVERY_CHIP[a.kind]))
    .join(" · ");
}

/** The human decisions for an incident: pending ones first, then decided ones, newest first. */
export function decisionsFor(state: CrisisState, incidentId: string | undefined): Approval[] {
  if (!incidentId) return [];
  const all = Object.values(state.approvals).filter((a) => a.incidentId === incidentId);
  const pending = all.filter((a) => a.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  const decided = all.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  return [...pending, ...decided];
}
