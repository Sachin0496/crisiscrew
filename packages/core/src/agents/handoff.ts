import type { Approval } from "@crisiscrew/contracts";
import { inr } from "../recovery/templates";
import type { AgentKit } from "./kit";

/** Handoff Agent: builds the case for a human and asks for approval. It cannot decide; it can only carry out a decision. */
export async function requestApproval(kit: AgentKit, incidentId: string): Promise<void> {
  kit.setAgent("handoff", "working", "Building the case for a human approver");
  const r = await kit.gate.call("handoff", "request_human_approval", { incidentId });
  if (!r.ok) {
    kit.setAgent("handoff", "done", `Could not request approval: ${r.reason}`);
    return;
  }
  const credit = kit.state().incidents[incidentId]?.credit;
  kit.setStatus(
    incidentId,
    "awaiting_approval",
    `${inr(credit?.amountInr ?? 0)} credit exceeds the ${inr(kit.policy.limits.authorityLimitInr)} authority limit; waiting for a human`,
  );
  kit.setAgent("handoff", "idle", "Waiting for the approver");
}

/** Carries out the human's decision. Only an approved or modified approval can pay, and only its exact amount. */
export async function carryOutDecision(kit: AgentKit, approval: Approval): Promise<void> {
  if (approval.status === "rejected") {
    kit.setStatus(approval.incidentId, "mitigated", `Credit rejected by ${approval.decidedBy}${approval.note ? `: ${approval.note}` : ""}`);
    kit.setAgent("handoff", "done", "The approver rejected the credit; nothing was issued");
    return;
  }
  const amountInr = approval.approvedAmountInr ?? approval.amountInr;
  kit.setAgent("handoff", "working", `Issuing the approved ${inr(amountInr)} credit`);
  const r = await kit.gate.call("handoff", "issue_recovery_credit", { incidentId: approval.incidentId, amountInr, approvalId: approval.id });
  kit.setStatus(approval.incidentId, "mitigated", r.ok ? `${inr(amountInr)} credit issued as approved by ${approval.decidedBy}` : `Credit not issued: ${r.reason}`);
  kit.setAgent("handoff", "done", r.ok ? `Issued ${inr(amountInr)} as approved` : `Credit not issued: ${r.reason}`);
}
