import type { Customer } from "@crisiscrew/contracts";
import { personalise, type Draft } from "../recovery/templates";
import { inBatches, type AgentKit } from "./kit";

type Affected = { ticketed: string[]; silent: string[]; since: number };

/** Customers who filed a ticket in the incident, with the name on their ticket. */
function ticketedNames(kit: AgentKit, incidentId: string): Map<string, string> {
  const s = kit.state();
  const incident = s.incidents[incidentId]!;
  const names = new Map<string, string>();
  for (const id of [...incident.ticketIds, ...incident.linkedTicketIds]) {
    const t = s.tickets[id]?.ticket;
    if (t) names.set(t.customerRef, t.customerName);
  }
  return names;
}

async function identify(kit: AgentKit, incidentId: string, sinceMs?: number): Promise<Affected | null> {
  const r = await kit.gate.call("recovery", "identify_affected_customers", { incidentId, ...(sinceMs !== undefined ? { sinceMs } : {}) });
  if (!r.ok) return null;
  const affected = r.result as Affected;
  kit.emit({ type: "customers.identified", payload: { incidentId, ...affected } });
  return affected;
}

function reply(kit: AgentKit, incidentId: string, customerRef: string, name: string, draft: Draft) {
  return kit.gate.call("recovery", "send_customer_update", { incidentId, customerRef, channel: "ticket_reply", text: personalise(draft.body, name) });
}

/** Phase 1, in parallel with the Investigator: link the cluster's tickets and find everyone affected. */
export async function startRecovery(kit: AgentKit, incidentId: string): Promise<void> {
  const incident = kit.state().incidents[incidentId]!;
  kit.setAgent("recovery", "working", "Linking tickets and finding affected customers");
  await inBatches(incident.ticketIds, 4, (ticketId) => kit.gate.call("recovery", "link_ticket_to_incident", { incidentId, ticketId }));
  await identify(kit, incidentId);
  kit.setAgent("recovery", "idle", "Waiting for the root cause");
}

/**
 * Phase 2, once the cause is known: one consistent update for everyone
 * affected, through the channel each customer allows, then a credit proposal.
 * Returns whether the credit needs a human.
 */
export async function finishRecovery(
  kit: AgentKit,
  incidentId: string,
  customerOf: (ref: string) => Promise<Customer | null>,
): Promise<"mitigated" | "needs_approval"> {
  kit.setStatus(incidentId, "recovering", "Updating affected customers");
  kit.setAgent("recovery", "working", "Updating affected customers");

  let incident = kit.state().incidents[incidentId]!;
  const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  if (root?.startedAt !== undefined && incident.affected && root.startedAt < incident.affected.since) {
    await identify(kit, incidentId, root.startedAt);
    incident = kit.state().incidents[incidentId]!;
  }

  const drafted = await kit.gate.call("recovery", "draft_customer_update", { incidentId });
  if (drafted.ok && incident.affected) {
    const draft = drafted.result as Draft;
    const silent = (await Promise.all(incident.affected.silent.map(customerOf))).filter((c): c is Customer => c !== null);

    await inBatches([...ticketedNames(kit, incidentId)], 5, ([ref, name]) => reply(kit, incidentId, ref, name, draft));
    await inBatches(
      silent.filter((c) => c.consent.proactive),
      5,
      (c) => kit.gate.call("recovery", "send_customer_update", { incidentId, customerRef: c.ref, channel: "proactive_message", text: personalise(draft.body, c.name) }),
    );
    const priority = silent.filter((c) => c.tier === "priority" && c.consent.voice);
    if (priority.length > 0) kit.setAgent("recovery", "working", `Preparing voice updates for ${priority.length} priority customers`);
    await inBatches(priority, 2, (c) =>
      kit.gate.call("recovery", "send_customer_update", { incidentId, customerRef: c.ref, channel: "voice", text: personalise(draft.voiceScript, c.name) }),
    );
  }

  const proposed = await kit.gate.call("recovery", "propose_recovery_credit", { incidentId });
  if (!proposed.ok) {
    kit.setAgent("recovery", "done", `Credit not proposed: ${proposed.reason}`);
    return "mitigated";
  }
  const { amountInr, withinAuthority } = proposed.result as { amountInr: number; withinAuthority: boolean };
  if (!withinAuthority) {
    kit.setAgent("recovery", "done", "The credit is above my authority, so it goes to the Handoff Agent");
    return "needs_approval";
  }
  const issued = await kit.gate.call("recovery", "issue_recovery_credit", { incidentId, amountInr });
  kit.setAgent("recovery", "done", issued.ok ? "Credit issued within my authority" : `Credit not issued: ${issued.reason}`);
  return "mitigated";
}

/** A later complaint that matches an open incident: link it, move the customer to "contacted us", and reply if updates already went out. */
export async function linkLateTicket(kit: AgentKit, incidentId: string, ticketId: string): Promise<void> {
  kit.setAgent("recovery", "working", `Linking ${ticketId} to ${incidentId}`);
  await kit.gate.call("recovery", "link_ticket_to_incident", { incidentId, ticketId });
  const s = kit.state();
  const incident = s.incidents[incidentId]!;
  const ticket = s.tickets[ticketId]!.ticket;
  if (incident.affected) {
    kit.emit({
      type: "customers.identified",
      payload: {
        incidentId,
        ticketed: [...new Set([...incident.affected.ticketed, ticket.customerRef])],
        silent: incident.affected.silent.filter((r) => r !== ticket.customerRef),
        since: incident.affected.since,
      },
    });
  }
  const draft = kit.draftFor(incidentId);
  const alreadyReplied = incident.updates.some((u) => u.customerRef === ticket.customerRef && u.channel === "ticket_reply");
  if (draft && !alreadyReplied) await reply(kit, incidentId, ticket.customerRef, ticket.customerName, draft);
  kit.setAgent("recovery", "done", `Linked ${ticketId}`);
}
