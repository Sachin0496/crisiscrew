import type { CallView } from "@crisiscrew/contracts";
import { callNote } from "../recovery/templates";
import { resettle } from "./commander";
import type { AgentKit } from "./kit";
import { updateAction } from "./recovery";

/**
 * Follows the Handoff Agent's calls to customers. The call's first update
 * (queued) marks its action as calling; how it ends settles it:
 * - answered: done. Pressing 2 asks for a callback (the note says so);
 *   pressing 3 withdraws voice consent;
 * - no answer or busy: called again after voice.retryAfterMin, up to
 *   voice.maxAttempts, then "not reached": the written update stands;
 * - failed: failed, with the reason.
 * Every ending leaves a note (on their ticket if they wrote in, on their
 * account otherwise), and the incident's coverage is worked out again.
 */
export async function onCustomerCall(kit: AgentKit, call: CallView): Promise<void> {
  const incidentId = call.metadata?.incidentId;
  const actionId = call.metadata?.actionId;
  if (!incidentId || !actionId) return;
  const incident = kit.state().incidents[incidentId];
  const action = incident?.actions.find((a) => a.id === actionId);
  if (!incident || !action) return;

  if (call.state === "queued") {
    if (action.callId !== call.id) updateAction(kit, action, { status: "calling", callId: call.id, attempts: (action.attempts ?? 0) + 1, detail: `${call.id} · calling` });
    return;
  }
  if (action.callId !== call.id || action.status !== "calling") return;
  if (!["completed", "no_answer", "busy", "failed"].includes(call.state)) return;

  const customer = incident.impact?.customers.find((c) => c.ref === action.customerRef);
  if (!customer) return;
  const attempts = action.attempts ?? 1;

  if (call.state === "failed") {
    updateAction(kit, action, { status: "failed", detail: `${call.id} · call failed${call.reason ? `: ${call.reason}` : ""}` });
    await resettle(kit, incidentId);
    return;
  }

  if (call.state === "completed") {
    if (call.digits?.startsWith("3")) await kit.gate.call("handoff", "record_contact_preference", { incidentId, customerRef: customer.ref, channel: "voice" });
    const choice = call.digits?.startsWith("1") ? "heard the status" : call.digits?.startsWith("2") ? "asked for a callback" : call.digits?.startsWith("3") ? "asked not to be called again" : "pressed nothing";
    updateAction(kit, action, { status: "done", detail: `${call.id} · answered${call.durationSec !== undefined ? ` (${call.durationSec} s)` : ""}; ${choice}` });
    await writeBack(kit, incidentId, customer, callNote(incidentId, customer, { answered: true, attempts, ...(call.durationSec !== undefined ? { durationSec: call.durationSec } : {}), ...(call.digits ? { digits: call.digits } : {}) }));
    kit.setAgent("handoff", "working", `${customer.name} answered and ${choice}`);
    await resettle(kit, incidentId);
    return;
  }

  // No answer, or busy.
  const reason = call.state === "busy" ? "line busy" : "no answer";
  const { maxAttempts, retryAfterMin } = kit.policy.voice;
  if (attempts < maxAttempts && kit.alive()) {
    updateAction(kit, action, { detail: `${call.id} · ${reason}; calling again in ${retryAfterMin} min (call ${attempts + 1} of ${maxAttempts})` });
    await kit.sleep(retryAfterMin * 60_000);
    const current = kit.state().incidents[incidentId]?.actions.find((a) => a.id === actionId);
    if (!current || current.callId !== call.id || current.status !== "calling") return;
    const r = await kit.gate.call("handoff", "send_customer_update", {
      incidentId,
      customerRef: customer.ref,
      channel: "voice",
      text: lastScript(kit, incidentId, actionId),
      actionId,
    });
    if (r.ok) return;
    // The gate refused the next call (calling hours, consent withdrawn, …): stop here.
    updateAction(kit, current, { status: "unreached", detail: `${call.id} · ${reason}; not called again: ${r.reason}` });
    await writeBack(kit, incidentId, customer, callNote(incidentId, customer, { answered: false, attempts, reason: r.reason }));
    await resettle(kit, incidentId);
    return;
  }
  updateAction(kit, action, { status: "unreached", detail: `${call.id} · ${reason}; not reached after ${attempts} ${attempts === 1 ? "call" : "calls"}` });
  await writeBack(kit, incidentId, customer, callNote(incidentId, customer, { answered: false, attempts, reason }));
  await resettle(kit, incidentId);
}

/** The script the action's first call used, so a retry says the same thing. */
function lastScript(kit: AgentKit, incidentId: string, actionId: string): string {
  return kit.state().incidents[incidentId]!.updates.findLast((u) => u.actionId === actionId)!.text;
}

/** The call's outcome where support will see it: the customer's ticket if they wrote in, their account otherwise. */
async function writeBack(kit: AgentKit, incidentId: string, customer: { ref: string; ticketIds: string[] }, text: string): Promise<void> {
  const ticketId = customer.ticketIds.at(-1);
  if (ticketId) await kit.gate.call("handoff", "add_ticket_note", { incidentId, ticketId, text });
  else await kit.gate.call("handoff", "add_account_note", { incidentId, customerRef: customer.ref, text });
}
