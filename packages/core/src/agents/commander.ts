import type { ClusterView, Customer } from "@crisiscrew/contracts";
import { requestApproval } from "./handoff";
import { investigate } from "./investigator";
import type { AgentKit } from "./kit";
import { finishRecovery, startRecovery } from "./recovery";

/**
 * Incident Commander: opens the incident, runs the Investigator and the
 * Recovery Agent in parallel, then routes the outcome, either mitigated within
 * authority or handed to a human.
 */
export async function runIncident(
  kit: AgentKit,
  cluster: ClusterView,
  incidentId: string,
  customerOf: (ref: string) => Promise<Customer | null>,
  onOpened: () => void,
): Promise<void> {
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
  await Promise.all([investigate(kit, incidentId), startRecovery(kit, incidentId)]);

  const outcome = await finishRecovery(kit, incidentId, customerOf);
  if (outcome === "needs_approval") {
    kit.setAgent("commander", "working", "Routing the credit decision to a human");
    await requestApproval(kit, incidentId);
    kit.setAgent("commander", "done", `${incidentId} is waiting for a human decision`);
  } else {
    kit.setStatus(incidentId, "mitigated", "Customers updated and the credit settled within authority");
    kit.setAgent("commander", "done", `${incidentId} mitigated`);
  }
}
