import type { Approval } from "@crisiscrew/contracts";
import { inr } from "../recovery/templates";
import type { AgentKit } from "./kit";
import { updateAction } from "./recovery";

/**
 * Handoff Agent: for each credit above the agents' authority, builds that
 * customer's case and asks a human. It cannot decide; it can only carry out
 * a decision.
 */
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
