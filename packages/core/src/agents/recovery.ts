import {
  actionsFor,
  customerState,
  OUTREACH_KINDS,
  type AffectedCustomer,
  type CustomerImpact,
  type Identity,
  type RecoveryAction,
} from "@crisiscrew/contracts";
import type { ToolCallResult } from "../policy/gate";
import { outcomeNote } from "../recovery/templates";
import { inBatches, type AgentKit } from "./kit";

/** Records an action's new status. */
export function updateAction(kit: AgentKit, action: RecoveryAction, change: Partial<RecoveryAction>): void {
  kit.emit({ type: "recovery.updated", payload: { incidentId: action.incidentId, action: { ...action, ...change, updatedAt: kit.now() } } });
}

/** Builds (or rebuilds) the Customer Impact Graph from the orders data and the incident's tickets. */
export async function assessImpact(kit: AgentKit, incidentId: string): Promise<CustomerImpact | null> {
  const r = await kit.gate.call("recovery", "identify_affected_customers", { incidentId });
  if (!r.ok) return null;
  const impact = r.result as CustomerImpact;
  kit.emit({ type: "impact.assessed", payload: { incidentId, impact } });
  return impact;
}

/** Phase 1, in parallel with the Investigator: link the cluster's tickets and find everyone affected. */
export async function startRecovery(kit: AgentKit, incidentId: string): Promise<void> {
  const incident = kit.state().incidents[incidentId]!;
  kit.setAgent("recovery", "working", "Linking tickets and finding affected customers");
  await inBatches(incident.ticketIds, 4, (ticketId) => kit.gate.call("recovery", "link_ticket_to_incident", { incidentId, ticketId }));
  await kit.serial(incidentId, () => assessImpact(kit, incidentId));
  kit.setAgent("recovery", "idle", "Waiting for the root cause");
}

function evidenceSummary(customer: AffectedCustomer): string {
  return customer.evidence
    .filter((e) => e.kind === "payment_failed" || e.kind === "payment_pending")
    .map((e) => e.label)
    .join("; ");
}

/**
 * Carries out one planned action of the Recovery Agent's own, within its
 * authority: a note on the account of a customer nobody may message, or a
 * credit. Customer outreach is the Handoff Agent's (reachOut).
 */
async function carryOut(kit: AgentKit, action: RecoveryAction, customer: AffectedCustomer | undefined): Promise<void> {
  if (!customer) {
    updateAction(kit, action, { status: "failed", detail: "No longer in the impact graph" });
    return;
  }
  const { incidentId, customerRef } = action;
  let r: ToolCallResult;
  switch (action.kind) {
    case "account_note":
      r = await kit.gate.call("recovery", "add_account_note", {
        incidentId,
        customerRef,
        text: `Affected by ${incidentId}: ${evidenceSummary(customer)}. Opted out of proactive messages, so CrisisCrew didn't contact them.`,
      });
      break;
    case "credit":
      r = await kit.gate.call("recovery", "issue_recovery_credit", { incidentId, customerRef, amountInr: action.amountInr });
      break;
    default:
      return;
  }
  if (!r.ok) {
    updateAction(kit, action, { status: "failed", detail: r.reason });
    return;
  }
  const result = r.result as { noteId?: string; creditId?: string };
  updateAction(kit, action, { status: "done", detail: `${action.kind === "credit" ? result.creditId : result.noteId} · ${r.entry.adapter}` });
}

/**
 * Writes the outcome back to each complaint's ticket once that customer's
 * recovery is settled: a private note with the evidence and what was done.
 * In Freshdesk mode it lands on the Freshdesk ticket.
 */
export async function noteOutcomes(kit: AgentKit, incidentId: string, identity: Extract<Identity, "recovery" | "handoff">): Promise<void> {
  const incident = kit.state().incidents[incidentId];
  if (!incident?.impact) return;
  for (const customer of incident.impact.customers) {
    const key = `${incidentId}:${customer.ref}`;
    const ticketId = customer.ticketIds.at(-1);
    if (!ticketId || kit.noted.has(key)) continue;
    const actions = actionsFor(incident, customer.ref);
    const state = customerState(customer, actions);
    const settled = state === "recovered" || (state === "unverified" && actions.length > 0 && actions.every((a) => a.status !== "planned"));
    if (!settled) continue;
    kit.noted.add(key);
    await kit.gate.call(identity, "add_ticket_note", { incidentId, ticketId, text: outcomeNote(incident, customer, actions) });
  }
}

/**
 * The Recovery Agent's part of a recovery pass: rebuild the impact graph if
 * asked, draft the incident's messages, plan the actions each customer is
 * still missing, and carry out its own within its authority (account notes
 * and credits). Outreach and credits above authority stay planned for the
 * Handoff Agent.
 */
export async function reconcile(kit: AgentKit, incidentId: string, options: { assessFirst: boolean }): Promise<void> {
  kit.setAgent("recovery", "working", "Planning each affected customer's recovery");
  if (options.assessFirst) await assessImpact(kit, incidentId);
  if (!kit.draftFor(incidentId)) await kit.gate.call("recovery", "draft_customer_update", { incidentId });
  const draft = kit.draftFor(incidentId);
  const planned = await kit.gate.call("recovery", "plan_recovery", { incidentId });
  if (!draft || !planned.ok) {
    kit.setAgent("recovery", "done", `Recovery stopped: ${planned.ok ? "no update could be drafted" : planned.reason}`);
    return;
  }

  const incident = kit.state().incidents[incidentId]!;
  const customers = new Map((incident.impact?.customers ?? []).map((c) => [c.ref, c]));
  const todo = incident.actions.filter((a) => a.status === "planned" && (a.kind === "credit" || a.kind === "account_note") && a.level !== null && a.level <= 2);
  if (todo.length > 0) kit.setAgent("recovery", "working", `Carrying out ${todo.length} credits and notes within my authority`);
  if (todo.length > 0) await kit.tracer.span({ name: "act_within_authority", kind: "node", actor: "recovery" }, () => inBatches(todo, 5, (action) => carryOut(kit, action, customers.get(action.customerRef))));

  const after = kit.state().incidents[incidentId]!;
  const outreach = after.actions.filter((a) => OUTREACH_KINDS.includes(a.kind) && a.status === "planned").length;
  const waiting = after.actions.filter((a) => a.level === 3 && a.status === "planned").length;
  const handed = [outreach ? `${outreach} ${outreach === 1 ? "message" : "messages"}` : "", waiting ? `${waiting} ${waiting === 1 ? "credit" : "credits"} above my authority` : ""].filter(Boolean);
  kit.setAgent("recovery", "done", `Planned every affected customer's recovery${handed.length ? `; handed ${handed.join(" and ")} to the Handoff Agent` : ""}`);
}
