import {
  actionsFor,
  customerState,
  recoveryCoverage,
  type AffectedCustomer,
  type CustomerImpact,
  type Identity,
  type RecoveryAction,
} from "@crisiscrew/contracts";
import type { ToolCallResult } from "../policy/gate";
import { outcomeNote, personalise, type Draft } from "../recovery/templates";
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

/** Carries out one planned action within the agents' authority and records the outcome on the action. */
async function carryOut(kit: AgentKit, action: RecoveryAction, customer: AffectedCustomer | undefined, draft: Draft): Promise<void> {
  if (!customer) {
    updateAction(kit, action, { status: "failed", detail: "No longer in the impact graph" });
    return;
  }
  const { incidentId, customerRef } = action;
  const send = (channel: "ticket_reply" | "proactive_message" | "voice", text: string) =>
    kit.gate.call("recovery", "send_customer_update", { incidentId, customerRef, channel, text: personalise(text, customer.name), actionId: action.id });

  let r: ToolCallResult;
  switch (action.kind) {
    case "ticket_reply":
      r = await send("ticket_reply", draft.body);
      break;
    case "acknowledge":
      r = await send("ticket_reply", draft.acknowledgement);
      break;
    case "proactive_message":
      r = await send("proactive_message", draft.body);
      break;
    case "voice":
      r = await send("voice", draft.voiceScript);
      break;
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
  const result = r.result as { updateId?: string; status?: string; adapter?: string; noteId?: string; creditId?: string };
  if (action.kind === "credit") updateAction(kit, action, { status: "done", detail: `${result.creditId} · ${r.entry.adapter}` });
  else if (action.kind === "account_note") updateAction(kit, action, { status: "done", detail: `${result.noteId} · ${r.entry.adapter}` });
  else if (result.status === "prepared") updateAction(kit, action, { status: "prepared", detail: `${result.updateId}: prepared, voice is off` });
  else updateAction(kit, action, { status: "done", detail: `${result.updateId} · ${result.adapter ?? r.entry.adapter}` });
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
 * One recovery pass: rebuild the impact graph if asked, plan the actions
 * each customer is still missing, and carry out every planned action within
 * the agents' authority. Credits above it stay planned for the Handoff Agent.
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
  const todo = incident.actions.filter((a) => a.status === "planned" && a.level !== null && a.level <= 2);
  if (todo.length > 0) kit.setAgent("recovery", "working", `Carrying out ${todo.length} recovery actions within my authority`);
  await inBatches(todo, 5, (action) => carryOut(kit, action, customers.get(action.customerRef), draft));
  await noteOutcomes(kit, incidentId, "recovery");

  const coverage = recoveryCoverage(kit.state().incidents[incidentId]!);
  const waiting = kit.state().incidents[incidentId]!.actions.filter((a) => a.level === 3 && a.status === "planned").length;
  kit.setAgent(
    "recovery",
    "done",
    `${coverage.recovered} of ${coverage.confirmed} affected customers recovered${waiting ? `; ${waiting} ${waiting === 1 ? "credit is" : "credits are"} above my authority, so they go to the Handoff Agent` : ""}`,
  );
}
