import type { Deployment, ErrorRatePoint, ProviderHealth } from "../ports";
import { scoreHypotheses } from "../rca/score";
import { investigationNarrative } from "../recovery/templates";
import type { AgentKit } from "./kit";

/**
 * Investigator (read-only): checks the payment gateway, recent releases and
 * error rates for the services behind the incident's product area, then
 * ranks root causes from that evidence.
 */
export async function investigate(kit: AgentKit, incidentId: string): Promise<void> {
  const incident = kit.state().incidents[incidentId]!;
  kit.setAgent("investigator", "working", "Checking the payment gateway, recent releases and error rates");

  const services = kit.ports.catalog.servicesFor(incident.surface).map((s) => s.name);
  const lookbackMin = kit.policy.rca.lookbackHours * 60;
  const call = (tool: string, args: object) => kit.gate.call("investigator", tool, args);

  const [health, deployCalls, metricCalls] = await Promise.all([
    call("get_payment_health", {}),
    Promise.all(services.map((service) => call("get_recent_deployments", { service, sinceMinutes: lookbackMin }))),
    Promise.all(services.map((service) => call("get_service_status", { service, minutes: lookbackMin + 60 }))),
  ]);

  const okDeploys = deployCalls.filter((c) => c.ok);
  const deployments = services.length === 0 || okDeploys.length > 0 ? okDeploys.flatMap((c) => (c.ok ? (c.result as Deployment[]) : [])) : null;
  const okMetrics = metricCalls.filter((c) => c.ok);
  const errorSeries =
    services.length === 0 || okMetrics.length > 0
      ? Object.fromEntries(okMetrics.map((c) => (c.ok ? [(c.result as { service: string }).service, (c.result as { points: ErrorRatePoint[] }).points] : [])))
      : null;

  const view = kit.state();
  const tickets = [...incident.ticketIds, ...view.incidents[incidentId]!.linkedTicketIds].map((id) => view.tickets[id]);
  const firstComplaintAt = Math.min(...tickets.map((t) => t?.ticket.receivedAt ?? Number.POSITIVE_INFINITY));

  const hypotheses = scoreHypotheses(
    {
      firstComplaintAt,
      deployments,
      errorSeries,
      providers: health.ok ? (health.result as ProviderHealth[]) : null,
      paymentMethods: tickets.map((t) => t?.signal?.entities.paymentMethods ?? []),
      adapters: {
        deployments: deployCalls[0]?.entry.adapter ?? "sandbox",
        metrics: metricCalls[0]?.entry.adapter ?? "sandbox",
        payments: health.entry.adapter,
      },
    },
    kit.policy.rca,
  );

  const top = hypotheses[0];
  const rootCause =
    top && top.kind !== "unknown" && top.confidence >= kit.policy.rca.confidenceFloor
      ? { hypothesisId: top.id, label: top.label, confidence: top.confidence }
      : undefined;
  kit.emit({ type: "rootcause.ranked", payload: { incidentId, hypotheses, narrative: investigationNarrative(hypotheses), ...(rootCause ? { rootCause } : {}) } });

  if (rootCause) {
    kit.setStatus(incidentId, "root_cause_identified", `${rootCause.label} (${Math.round(rootCause.confidence * 100)}% confidence)`);
  }
  kit.setAgent("investigator", "done", rootCause ? `Root cause: ${rootCause.label}` : "No single cause stands out yet");
}
