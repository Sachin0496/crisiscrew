import { OUTREACH_KINDS, type AffectedCustomer, type Approval, type OutreachTrack, type RecoveryAction } from "@crisiscrew/contracts";
import { fillOutreach, inr, type Draft } from "../recovery/templates";
import { inBatches, type AgentKit } from "./kit";
import { updateAction } from "./recovery";

/**
 * Handoff Agent: every customer message, in two tracks, and every credit
 * above the agents' authority. For a credit it builds that customer's case
 * and asks a human; it cannot decide, only carry out a decision.
 */

const TRACK_ORDER: OutreachTrack[] = ["complained", "not_complained", "unverified"];

const TRACK_TASK: Record<OutreachTrack, (customers: number) => string> = {
  complained: (n) => `Complained track: answering ${n === 1 ? "one customer" : `${n} customers`} on their tickets`,
  not_complained: (n) => `Not-complained track: telling ${n === 1 ? "one customer" : `${n} customers`} about a failure they may not have noticed`,
  unverified: (n) => `Acknowledging ${n === 1 ? "one complaint" : `${n} complaints`} with no failed payment on record`,
};

/** The text one outreach action sends, filled for its customer. */
function messageFor(kit: AgentKit, action: RecoveryAction, customer: AffectedCustomer, draft: Draft): { channel: "ticket_reply" | "proactive_message" | "voice"; text: string } {
  const incident = kit.state().incidents[action.incidentId]!;
  const creditUnderReview = incident.actions.some((a) => a.customerRef === customer.ref && a.kind === "credit" && a.level === 3 && (a.status === "planned" || a.status === "awaiting_approval"));
  const ticketId = customer.ticketIds.at(-1);
  const ticket = ticketId ? kit.state().tickets[ticketId]?.ticket : undefined;
  const fill = (text: string) => fillOutreach(text, customer, { ticket: ticket ? (ticket.externalId ? `#${ticket.externalId}` : ticket.id) : undefined, creditUnderReview });
  const complained = action.track === "complained";
  switch (action.kind) {
    case "acknowledge":
      return { channel: "ticket_reply", text: fill(draft.acknowledgement) };
    case "ticket_reply":
      return { channel: "ticket_reply", text: fill(draft.complained) };
    case "proactive_message":
      return { channel: "proactive_message", text: fill(draft.notComplained) };
    default:
      return { channel: "voice", text: fill(complained ? draft.voice.complained : draft.voice.notComplained) };
  }
}

async function send(kit: AgentKit, action: RecoveryAction, customer: AffectedCustomer | undefined, draft: Draft): Promise<void> {
  if (!customer) {
    updateAction(kit, action, { status: "failed", detail: "No longer in the impact graph" });
    return;
  }
  const { channel, text } = messageFor(kit, action, customer, draft);
  const r = await kit.gate.call("handoff", "send_customer_update", { incidentId: action.incidentId, customerRef: customer.ref, channel, text, actionId: action.id });
  if (!r.ok) {
    updateAction(kit, action, { status: "failed", detail: r.reason });
    return;
  }
  const result = r.result as { updateId: string; status: string; adapter?: string };
  if (result.status === "prepared") updateAction(kit, action, { status: "prepared", detail: `${result.updateId}: prepared, voice is off` });
  else updateAction(kit, action, { status: "done", detail: `${result.updateId} · ${result.adapter ?? r.entry.adapter}` });
}

/**
 * Customer outreach, one track at a time: first those who complained, then
 * those who didn't, then acknowledgements for complaints with no evidence.
 * It runs before any approval is requested, so a customer whose credit waits
 * for a human still hears from us at once; their message says a credit is
 * being reviewed, without an amount.
 */
export async function reachOut(kit: AgentKit, incidentId: string): Promise<void> {
  const draft = kit.draftFor(incidentId);
  const incident = kit.state().incidents[incidentId]!;
  const todo = incident.actions.filter((a) => OUTREACH_KINDS.includes(a.kind) && a.status === "planned");
  if (!draft || todo.length === 0) return;
  const customers = new Map((incident.impact?.customers ?? []).map((c) => [c.ref, c]));
  for (const track of TRACK_ORDER) {
    const mine = todo.filter((a) => (a.track ?? "unverified") === track);
    if (mine.length === 0) continue;
    kit.setAgent("handoff", "working", TRACK_TASK[track](new Set(mine.map((a) => a.customerRef)).size));
    await inBatches(mine, 5, (action) => send(kit, action, customers.get(action.customerRef), draft));
  }
  const sent = kit.state().incidents[incidentId]!.actions.filter((a) => todo.some((t) => t.id === a.id) && (a.status === "done" || a.status === "prepared")).length;
  kit.setAgent("handoff", "idle", `Sent ${sent} of ${todo.length} ${todo.length === 1 ? "message" : "messages"}`);
}
export async function requestApprovals(kit: AgentKit, incidentId: string): Promise<void> {
  const escalated = kit.state().incidents[incidentId]!.actions.filter((a) => a.kind === "credit" && a.level === 3 && a.status === "planned");
  if (escalated.length === 0) return;
  kit.setAgent("handoff", "working", `Building the case for ${escalated.length === 1 ? "one customer" : `${escalated.length} customers`} for a human approver`);
  for (const credit of escalated) {
    const r = await kit.gate.call("handoff", "request_human_approval", { incidentId, customerRef: credit.customerRef });
    if (r.ok) updateAction(kit, credit, { status: "awaiting_approval", approvalId: (r.result as { approvalId: string }).approvalId });
    else updateAction(kit, credit, { status: "failed", detail: `Approval not requested: ${r.reason}` });
  }
  kit.setAgent("handoff", "idle", "Waiting for the approver");
}

/** Carries out one human decision. Only an approved or modified approval can pay, and only its exact amount, to that customer. */
export async function carryOutDecision(kit: AgentKit, approval: Approval): Promise<void> {
  const credit = kit.state().incidents[approval.incidentId]?.actions.find((a) => a.id === approval.actionId);
  if (!credit) return;
  const by = approval.decidedBy ?? "the approver";
  if (approval.status === "rejected") {
    updateAction(kit, credit, { status: "declined", detail: `Declined by ${by}${approval.note ? `: “${approval.note}”` : ""}` });
    kit.setAgent("handoff", "done", `${by} declined ${approval.customerName}'s credit; nothing was issued`);
    return;
  }
  const amountInr = approval.approvedAmountInr ?? approval.amountInr;
  kit.setAgent("handoff", "working", `Issuing ${approval.customerName}'s approved ${inr(amountInr)} credit`);
  const r = await kit.gate.call("handoff", "issue_recovery_credit", {
    incidentId: approval.incidentId,
    customerRef: approval.customerRef,
    amountInr,
    approvalId: approval.id,
  });
  if (!r.ok) {
    updateAction(kit, credit, { status: "failed", detail: `Not issued: ${r.reason}` });
    kit.setAgent("handoff", "done", `Credit not issued: ${r.reason}`);
    return;
  }
  const changed = amountInr !== approval.amountInr ? `, changed from ${inr(approval.amountInr)}` : "";
  updateAction(kit, credit, { status: "done", amountInr, detail: `${(r.result as { creditId: string }).creditId} · approved by ${by}${changed}` });
  kit.setAgent("handoff", "done", `Issued ${approval.customerName}'s ${inr(amountInr)} credit as approved`);
}
