import { recoveryCoverage, type ClusterView, type IncidentStatus } from "@crisiscrew/contracts";
import { coverageNote } from "../recovery/templates";
import type { AgentKit } from "./kit";

/**
 * Incident Commander: opens the incident, files it where engineering works,
 * and drives recovery until every affected customer is covered or waiting
 * for a human. The order of its steps lives in the LangGraph workflows
 * (src/workflows); these are the steps.
 */

/** Opens the incident for a cluster that passed every detection gate. */
export async function openIncident(kit: AgentKit, cluster: ClusterView, incidentId: string): Promise<{ opened: true; severity: "high" | "medium" } | { opened: false; reason: string }> {
  kit.setAgent("commander", "working", `Opening ${incidentId}`);
  const severity = cluster.dominantSurface === "checkout_payments" ? "high" : "medium";
  const opened = await kit.gate.call("commander", "open_incident", {
    incidentId,
    clusterId: cluster.id,
    ticketIds: cluster.reportTicketIds,
    surface: cluster.dominantSurface,
    severity,
  });
  if (!opened.ok) {
    kit.setAgent("commander", "done", `Could not open ${incidentId}: ${opened.reason}`);
    return { opened: false, reason: opened.reason };
  }
  kit.setStatus(incidentId, "investigating", "Investigator and Recovery Agent started in parallel");
  kit.setAgent("commander", "working", `Coordinating ${incidentId}`);
  return { opened: true, severity };
}

/** Files the incident where engineering works (Freshservice, or its sandbox). */
export async function fileEngineering(kit: AgentKit, incidentId: string): Promise<{ record: string | null; reason?: string }> {
  const r = await kit.gate.call("commander", "file_engineering_incident", { incidentId });
  return r.ok ? { record: (r.result as { id: string }).id } : { record: null, reason: r.reason };
}

/** Once the investigation and the first impact assessment are in: brief engineering, and move the incident to recovery. */
export async function briefEngineering(kit: AgentKit, incidentId: string): Promise<{ briefed: boolean }> {
  const incident = kit.state().incidents[incidentId]!;
  let briefed = false;
  if (incident.engineering && incident.narrative) {
    briefed = (await kit.gate.call("commander", "update_engineering_incident", { incidentId, note: `Investigation: ${incident.narrative}` })).ok;
  }
  kit.setStatus(incidentId, "recovering", "Planning a recovery for each affected customer");
  return { briefed };
}

/**
 * Sets the incident's status from Recovery Coverage. An incident is
 * Recovered only when every confirmed affected customer is; while a credit
 * waits for a human it's Awaiting approval.
 */
export async function settle(kit: AgentKit, incidentId: string): Promise<{ status: IncidentStatus; recovered: number; confirmed: number; pending: number }> {
  const incident = kit.state().incidents[incidentId]!;
  const coverage = recoveryCoverage(incident);
  const pending = Object.values(kit.state().approvals).filter((a) => a.incidentId === incidentId && a.status === "pending").length;
  const tally = `recovery coverage ${coverage.recovered}/${coverage.confirmed}`;
  let to: IncidentStatus;
  let note: string;
  if (pending > 0) {
    to = "awaiting_approval";
    note = `${pending === 1 ? "One credit is" : `${pending} credits are`} above the agents' authority and waiting for a human; ${tally}`;
  } else if (coverage.complete) {
    to = "recovered";
    note = `Every one of the ${coverage.confirmed} affected customers has a completed recovery`;
  } else {
    to = "recovering";
    note =
      coverage.confirmed === 0
        ? "No complaint could be matched to a failed payment yet"
        : `${tally}${coverage.attention ? `; ${coverage.attention} need attention` : ""}`;
  }
  if (incident.status !== to) {
    kit.setStatus(incidentId, to, note);
    if (incident.engineering && to !== "recovering") {
      await kit.gate.call("commander", "update_engineering_incident", { incidentId, note: coverageNote(recoveryCoverage(kit.state().incidents[incidentId]!)) });
    }
  }
  const after = kit.state().incidents[incidentId]!;
  kit.setAgent(
    "commander",
    after.status === "recovered" ? "done" : "working",
    after.status === "recovered"
      ? `${incidentId} recovered: ${coverage.recovered} of ${coverage.confirmed} customers`
      : after.status === "awaiting_approval"
        ? `${incidentId} is waiting for ${pending === 1 ? "one human decision" : `${pending} human decisions`}`
        : `Coordinating ${incidentId}: ${tally}`,
  );
  return { status: after.status, recovered: coverage.recovered, confirmed: coverage.confirmed, pending };
}

/** A later complaint that matches an open incident: link it. */
export async function linkLateTicket(kit: AgentKit, incidentId: string, ticketId: string): Promise<{ linked: boolean; reason?: string }> {
  kit.setAgent("recovery", "working", `Linking ${ticketId} to ${incidentId}`);
  const r = await kit.gate.call("recovery", "link_ticket_to_incident", { incidentId, ticketId });
  return r.ok ? { linked: true } : { linked: false, reason: r.reason };
}
