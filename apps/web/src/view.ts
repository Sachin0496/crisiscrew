import type { ClusterView, CrisisState, IncidentStatus, IncidentView, Scenario, Surface } from "@crisiscrew/contracts";
import { inr, type Tone } from "./format";

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
  if (expected.affected !== undefined) parts.push(`${expected.affected} customers affected${expected.silent !== undefined ? ` (${expected.silent} silent)` : ""}`);
  if (expected.creditInr) parts.push(`a ${inr(expected.creditInr)} credit for a human to decide`);
  return `Expected: ${joinList(parts)}`;
}

const TITLES: Record<Surface, string> = {
  checkout_payments: "Checkout and payment failures",
  login_account: "Login and account failures",
  delivery_orders: "Delivery and order failures",
  refunds_billing: "Refund and billing failures",
  app_performance: "App performance failures",
  other: "Customer-reported failures",
};

/** An incident's headline, named after the product area that is failing. */
export const incidentTitle = (surface: Surface) => TITLES[surface];

export type StepState = "done" | "current" | "upcoming";
export type ProgressStep = { key: IncidentStatus; label: string; state: StepState; at?: number };

const STEPS: { key: IncidentStatus; label: string }[] = [
  { key: "detected", label: "Detected" },
  { key: "investigating", label: "Investigating" },
  { key: "root_cause_identified", label: "Root cause" },
  { key: "recovering", label: "Recovering" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "mitigated", label: "Mitigated" },
];

/**
 * The incident's progress for the stepper. The approval step only appears
 * once a human decision has been asked for; a credit within authority never
 * needs one.
 */
export function progressSteps(incident: Pick<IncidentView, "status" | "timeline" | "approvalId">): ProgressStep[] {
  const needsHuman = Boolean(incident.approvalId) || incident.status === "awaiting_approval";
  const steps = STEPS.filter((s) => s.key !== "awaiting_approval" || needsHuman);
  const finished = incident.status === "mitigated" || incident.status === "resolved";
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
