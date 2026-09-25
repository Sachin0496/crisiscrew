import type { CallView, PageAttemptState } from "@crisiscrew/contracts";
import { pageNote } from "../recovery/templates";
import { patchAttempt } from "../tools/definitions";
import type { AgentKit } from "./kit";

/**
 * Paging, as the Incident Commander runs it: call the primary responder once
 * the incident's importance says to, follow the call, and if it ends without
 * an acknowledgement wait ackTimeoutMin (someone may still acknowledge in
 * CrisisCrew or Freshservice) before escalating to the next responder, up to
 * maxEscalations. Every call is a gated, audited page_on_call.
 */

/** Adds a private note to the engineering incident, when there is one. */
async function noteEngineering(kit: AgentKit, incidentId: string, note: string): Promise<void> {
  if (!kit.state().incidents[incidentId]?.engineering) return;
  await kit.gate.call("commander", "update_engineering_incident", { incidentId, note });
}

async function page(kit: AgentKit, incidentId: string, attempt: number): Promise<void> {
  if (!kit.alive()) return;
  kit.setAgent("commander", "working", attempt === 1 ? `Paging on-call for ${incidentId}` : `Escalating ${incidentId}: paging responder ${attempt}`);
  const r = await kit.gate.call("commander", "page_on_call", { incidentId, attempt });
  const paging = kit.state().incidents[incidentId]?.paging;
  if (!r.ok) {
    // Out of escalations: say so on the incident, once.
    if (paging && paging.status === "paging" && /no escalations left/.test(r.reason ?? "")) {
      kit.emit({ type: "paging.updated", payload: { incidentId, paging: { ...paging, status: "exhausted", note: r.reason } } });
      kit.setAgent("commander", "working", `Nobody acknowledged ${incidentId} after ${paging.attempts.length} pages`);
      await noteEngineering(kit, incidentId, `On-call paging stopped: ${r.reason}. Nobody acknowledged.`);
    }
    return;
  }
  const result = r.result as { paged?: false; reason?: string; responder?: string };
  if (result.paged === false) {
    kit.setAgent("commander", "working", `Couldn't page on-call for ${incidentId}: ${result.reason}`);
    await noteEngineering(kit, incidentId, `On-call paging stopped: ${result.reason}.`);
  }
}

/** Pages on-call the first time the incident's importance calls for it. */
export async function pageIfNeeded(kit: AgentKit, incidentId: string): Promise<void> {
  const incident = kit.state().incidents[incidentId];
  if (!incident?.importance?.page || incident.paging) return;
  await page(kit, incidentId, 1);
}

const ENDED: Partial<Record<CallView["state"], PageAttemptState>> = {
  completed: "not_acknowledged",
  no_answer: "no_answer",
  busy: "busy",
  failed: "failed",
};

/** Follows one page call: a key press of 1 acknowledges; a call that ends without it escalates after the wait. */
export async function onPageCall(kit: AgentKit, call: CallView): Promise<void> {
  const incidentId = call.metadata?.incidentId;
  const attempt = Number(call.metadata?.attempt);
  if (!incidentId || !attempt) return;
  const entry = kit.state().incidents[incidentId]?.paging?.attempts.find((a) => a.attempt === attempt);
  if (!entry || entry.state !== "calling") return;

  if (call.digits?.includes("1")) {
    patchAttempt(kit, incidentId, attempt, { state: "acknowledged" }, { status: "acknowledged", acknowledgedBy: entry.responder, acknowledgedAt: kit.now(), via: "call" });
    kit.setAgent("commander", "working", `${entry.responder} (${entry.role} on-call) acknowledged ${incidentId}`);
    await noteEngineering(kit, incidentId, pageNote({ ...entry, state: "acknowledged" }, "call"));
    return;
  }
  const state = ENDED[call.state];
  if (!state) return;
  patchAttempt(kit, incidentId, attempt, { state, ...(call.reason ? { reason: call.reason } : {}) });
  await noteEngineering(kit, incidentId, pageNote({ ...entry, state, ...(call.reason ? { reason: call.reason } : {}) }));

  await kit.sleep(kit.policy.oncall.ackTimeoutMin * 60_000);
  const paging = kit.state().incidents[incidentId]?.paging;
  if (!paging || paging.status !== "paging" || paging.attempts.length !== attempt) return;
  await page(kit, incidentId, attempt + 1);
}

/** An operator acknowledges the page, in CrisisCrew or through Freshservice. Paging stops. */
export async function acknowledgeByOperator(kit: AgentKit, incidentId: string, by: string): Promise<void> {
  const paging = kit.state().incidents[incidentId]?.paging;
  if (!paging) throw new Error(`nobody has been paged for ${incidentId}`);
  if (paging.status === "acknowledged") return;
  kit.emit({ type: "paging.updated", payload: { incidentId, paging: { ...paging, status: "acknowledged", acknowledgedBy: by, acknowledgedAt: kit.now(), via: "operator" } } });
  kit.setAgent("commander", "working", `${by} acknowledged ${incidentId}`);
  await noteEngineering(kit, incidentId, `On-call page acknowledged by ${by}.`);
}
