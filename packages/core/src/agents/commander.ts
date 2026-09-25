import { recoveryCoverage, type Approval, type ClusterView, type IncidentStatus } from "@crisiscrew/contracts";
import { coverageNote } from "../recovery/templates";
import { carryOutDecision, requestApprovals } from "./handoff";
import { investigate } from "./investigator";
import type { AgentKit } from "./kit";
import { assessImpact, noteOutcomes, reconcile, startRecovery } from "./recovery";

/**
 * Sets the incident's status from Recovery Coverage. An incident is
 * Recovered only when every confirmed affected customer is; while a credit
 * waits for a human it's Awaiting approval.
 */
async function settle(kit: AgentKit, incidentId: string): Promise<void> {
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
}

/** One full recovery pass, then the approvals it needs and the incident's status, one pass at a time per incident. */
async function recover(kit: AgentKit, incidentId: string): Promise<void> {
  await kit.serial(incidentId, async () => {
    await reconcile(kit, incidentId, { assessFirst: true });
    await requestApprovals(kit, incidentId);
    await settle(kit, incidentId);
  });
}

/**
 * Incident Commander: opens the incident, files it where engineering works,
 * runs the Investigator and the Recovery Agent in parallel, then drives
 * recovery until every affected customer is covered or waiting for a human.
 */
export async function runIncident(kit: AgentKit, cluster: ClusterView, incidentId: string, onOpened: () => void): Promise<void> {
  kit.setAgent("commander", "working", `Opening ${incidentId}`);
  const severity = cluster.dominantSurface === "checkout_payments" ? "high" : "medium";
  const opened = await kit.gate.call("commander", "open_incident", {
    incidentId,
    clusterId: cluster.id,
    ticketIds: cluster.reportTicketIds,
    surface: cluster.dominantSurface,
    severity,
  });
  onOpened();
  if (!opened.ok) {
    kit.setAgent("commander", "done", `Could not open ${incidentId}: ${opened.reason}`);
    return;
  }

  kit.setStatus(incidentId, "investigating", "Investigator and Recovery Agent started in parallel");
  kit.setAgent("commander", "working", `Coordinating ${incidentId}`);
  await Promise.all([
    investigate(kit, incidentId),
    startRecovery(kit, incidentId),
    kit.gate.call("commander", "file_engineering_incident", { incidentId }),
  ]);

  const incident = kit.state().incidents[incidentId]!;
  if (incident.engineering && incident.narrative) {
    await kit.gate.call("commander", "update_engineering_incident", { incidentId, note: `Investigation: ${incident.narrative}` });
  }
  kit.setStatus(incidentId, "recovering", "Planning a recovery for each affected customer");
  await recover(kit, incidentId);
}

/**
 * A later complaint that matches an open incident: link it, then update the
 * impact graph. Once recovery is under way, a full pass follows, so a silent
 * customer who writes in gets a reply on their ticket and a new customer
 * gets a plan.
 */
export async function handleLateTicket(kit: AgentKit, incidentId: string, ticketId: string): Promise<void> {
  kit.setAgent("recovery", "working", `Linking ${ticketId} to ${incidentId}`);
  await kit.gate.call("recovery", "link_ticket_to_incident", { incidentId, ticketId });
  if (kit.draftFor(incidentId)) {
    await recover(kit, incidentId);
    return;
  }
  await kit.serial(incidentId, () => assessImpact(kit, incidentId));
  kit.setAgent("recovery", "idle", `Linked ${ticketId}; waiting for the root cause`);
}

/** Carries out a human decision, writes the outcome to the customer's ticket, and recomputes the incident's status. */
export async function settleDecision(kit: AgentKit, approval: Approval): Promise<void> {
  await kit.serial(approval.incidentId, async () => {
    await carryOutDecision(kit, approval);
    await noteOutcomes(kit, approval.incidentId, "handoff");
    await settle(kit, approval.incidentId);
  });
}
