import type { Deployment, ErrorRatePoint, InfraHealth, ProviderHealth } from "../ports";
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
  kit.setAgent("investigator", "working", "Checking the payment gateway, recent releases, error rates and infrastructure");

  const services = kit.ports.catalog.servicesFor(incident.surface).map((s) => s.name);
  const lookbackMin = kit.policy.rca.lookbackHours * 60;
  const call = (tool: string, args: object) => kit.gate.call("investigator", tool, args);

  const [health, deployCalls, metricCalls, infraCalls] = await Promise.all([
    call("get_payment_health", {}),
    Promise.all(services.map((service) => call("get_recent_deployments", { service, sinceMinutes: lookbackMin }))),
    Promise.all(services.map((service) => call("get_service_status", { service, minutes: lookbackMin + 60 }))),
    Promise.all(services.map((service) => call("get_infra_health", { service, minutes: 120 }))),
  ]);
  const okInfra = infraCalls.filter((c) => c.ok);
  const infra = okInfra.length > 0 ? Object.fromEntries(okInfra.map((c) => [(c.result as InfraHealth).service, c.result as InfraHealth])) : services.length === 0 ? {} : null;

  const okDeploys = deployCalls.filter((c) => c.ok);
  const deployments = services.length === 0 || okDeploys.length > 0 ? okDeploys.flatMap((c) => (c.ok ? (c.result as Deployment[]) : [])) : null;
  const okMetrics = metricCalls.filter((c) => c.ok);
  const errorSeries =
    services.length === 0 || okMetrics.length > 0
      ? Object.fromEntries(okMetrics.map((c) => (c.ok ? [(c.result as { service: string }).service, (c.result as { points: ErrorRatePoint[] }).points] : [])))
      : null;

  const view = kit.state();
  const current = view.incidents[incidentId]!;
  const tickets = [...current.ticketIds, ...current.linkedTicketIds].map((id) => view.tickets[id]);
  const alerts = (current.alertIds ?? []).map((id) => view.alerts[id]).filter((a) => a !== undefined);
  const firstTicketAt = Math.min(...tickets.map((t) => t?.ticket.receivedAt ?? Number.POSITIVE_INFINITY));
  const firstAlertAt = Math.min(...alerts.map((a) => a.firedAt));
  const firstSignal = firstAlertAt < firstTicketAt ? "alert" : "complaint";
  const firstComplaintAt = Math.min(firstTicketAt, firstAlertAt);

  const hypotheses = scoreHypotheses(
    {
      firstComplaintAt,
      firstSignal,
      alerts: alerts.map((a) => ({ service: a.service, severity: a.severity, label: a.label, firedAt: a.firedAt })),
      alertLr: kit.policy.alerts,
      deployments,
      errorSeries,
      providers: health.ok ? (health.result as ProviderHealth[]) : null,
      infra,
      paymentMethods: tickets.map((t) => t?.signal?.entities.paymentMethods ?? []),
      adapters: {
        deployments: deployCalls[0]?.entry.adapter ?? "sandbox",
        metrics: metricCalls[0]?.entry.adapter ?? "sandbox",
        payments: health.entry.adapter,
        infra: infraCalls[0]?.entry.adapter ?? "none",
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

  // A later re-ranking (an alert joined) updates the cause without moving the incident back.
  const status = kit.state().incidents[incidentId]!.status;
  if (rootCause && (status === "detected" || status === "investigating")) {
    kit.setStatus(incidentId, "root_cause_identified", `${rootCause.label} (${Math.round(rootCause.confidence * 100)}% confidence)`);
  }
  kit.setAgent("investigator", "done", rootCause ? `Root cause: ${rootCause.label}` : "No single cause stands out yet");
}
