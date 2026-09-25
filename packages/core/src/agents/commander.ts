import { recoveryCoverage, type Alert, type Approval, type ClusterView, type ImportanceAssessment, type IncidentStatus, type Surface } from "@crisiscrew/contracts";
import { assessImportance, higher, nextImportance, type ImportanceAlert } from "../importance/assess";
import { coverageNote, importanceNote } from "../recovery/templates";
import { carryOutDecision, reachOut, requestApprovals } from "./handoff";
import { investigate } from "./investigator";
import type { AgentKit } from "./kit";
import { fileIssue, openProblem } from "./issue-creator";
import { pageIfNeeded } from "./paging";
import { assessImpact, noteOutcomes, reconcile, startRecovery } from "./recovery";
import { runWorkflow } from "../workflows/graphs";

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
    if (to === "recovered") await openProblem(kit, incidentId);
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

/**
 * Keeps the engineering record's priority in step with the incident's
 * importance. Filing can race a reassessment, so this compares what the
 * record was filed or last set at, rather than trusting the moment of change.
 */
async function syncEngineering(kit: AgentKit, incidentId: string): Promise<void> {
  const incident = kit.state().incidents[incidentId];
  const record = incident?.engineering;
  const importance = incident?.importance;
  if (!record || !importance || record.importance === importance.level) return;
  await kit.gate.call("commander", "update_engineering_incident", { incidentId, importance: importance.level, note: importanceNote(importance) });
}

/** The incident's alerts that are still firing, as the importance rules read them. */
function linkedAlerts(kit: AgentKit, incidentId: string): ImportanceAlert[] {
  const view = kit.state();
  return (view.incidents[incidentId]?.alertIds ?? [])
    .map((id) => view.alerts[id])
    .filter((a) => a !== undefined && a.resolvedAt === undefined)
    .map((a) => ({ severity: a!.severity, service: a!.service, label: a!.label }));
}

/**
 * Re-applies the importance rules to what's now known about the incident.
 * The level only rises on its own (nextImportance), and the engineering
 * record's priority follows it.
 */
export async function reassess(kit: AgentKit, incidentId: string, stage: ImportanceAssessment["stage"]): Promise<void> {
  const incident = kit.state().incidents[incidentId];
  if (!incident) return;
  const assessed: ImportanceAssessment = { ...assessImportance(incident, linkedAlerts(kit, incidentId), kit.policy.importance), stage, source: "rules", assessedAt: kit.now() };
  const next = nextImportance(incident.importance, assessed);
  if (next) {
    kit.emit({ type: "incident.importance", payload: { incidentId, importance: next } });
    if (incident.importance && higher(next.level, incident.importance.level)) {
      kit.setAgent("commander", "working", `Raised ${incidentId} to ${next.level}${next.page ? ", page on-call" : ""}: ${next.reasons[0]?.text ?? "no rule"}`);
    }
  }
  await syncEngineering(kit, incidentId);
  await pageIfNeeded(kit, incidentId);
}

/** A human's decision on the incident's importance; the rules leave it alone from then on. */
export async function setImportanceByHuman(kit: AgentKit, incidentId: string, importance: ImportanceAssessment): Promise<void> {
  kit.emit({ type: "incident.importance", payload: { incidentId, importance } });
  kit.setAgent("commander", "working", `${importance.by ?? "A human"} set ${incidentId} to ${importance.level}`);
  await syncEngineering(kit, incidentId);
  await pageIfNeeded(kit, incidentId);
}

/** One full recovery pass, then the approvals it needs and the incident's status, one pass at a time per incident. */
async function recover(kit: AgentKit, incidentId: string): Promise<void> {
  await kit.serial(incidentId, () => runWorkflow(
    kit.tracer,
    { workflow: "recovery_pass", title: `Recovery ${incidentId}`, actor: "recovery", incidentId },
    "recover",
    { label: "Recover customers", actor: "recovery", description: "Plan, carry out, communicate, request approvals and settle coverage." },
    async () => {
      await kit.tracer.span({ name: "plan_recovery", kind: "node", actor: "recovery" }, () => reconcile(kit, incidentId, { assessFirst: true }));
      await kit.tracer.span({ name: "reach_out", kind: "node", actor: "handoff" }, () => reachOut(kit, incidentId));
      await kit.tracer.span({ name: "request_approvals", kind: "node", actor: "handoff" }, () => requestApprovals(kit, incidentId));
      await kit.tracer.span({ name: "write_back", kind: "node", actor: "handoff" }, () => noteOutcomes(kit, incidentId, "handoff"));
      await reassess(kit, incidentId, kit.state().incidents[incidentId]?.rootCause ? "root_cause" : "impact");
      await kit.tracer.span({ name: "settle", kind: "node", actor: "commander" }, () => settle(kit, incidentId));
    },
  ));
}

/**
 * Incident Commander: opens the incident, files it where engineering works,
 * runs the Investigator and the Recovery Agent in parallel, then drives
 * recovery until every affected customer is covered or waiting for a human.
 */
export function runIncident(kit: AgentKit, cluster: ClusterView, incidentId: string, onOpened: () => void): Promise<void> {
  return openAndRun(kit, { incidentId, clusterId: cluster.id, ticketIds: cluster.reportTicketIds, surface: cluster.dominantSurface }, onOpened);
}

/**
 * An incident opened by a critical alert, before anyone complains. It runs
 * the same way: the impact graph comes from payment evidence, so the
 * customers whose payments failed are found even with no ticket at all.
 */
export function runAlertIncident(kit: AgentKit, alert: Alert, surface: Surface, incidentId: string, onOpened: () => void): Promise<void> {
  return openAndRun(kit, { incidentId, clusterId: `alert:${alert.id}`, ticketIds: [], surface, alertId: alert.id }, onOpened);
}

type Opening = { incidentId: string; clusterId: string; ticketIds: string[]; surface: Surface; alertId?: string };

async function openAndRun(kit: AgentKit, opening: Opening, onOpened: () => void): Promise<void> {
  const { incidentId, alertId } = opening;
  kit.setAgent("commander", "working", `Opening ${incidentId}`);
  // Before the investigation, only the product area and the triggering alert are known.
  const alert = alertId ? kit.state().alerts[alertId] : undefined;
  const initial = assessImportance({ surface: opening.surface, hypotheses: [] }, alert ? [alert] : [], kit.policy.importance);
  const opened = await kit.tracer.span({ name: "open_incident", kind: "node", actor: "commander" }, () => kit.gate.call("commander", "open_incident", { ...opening, importance: initial.level }));
  if (opened.ok) kit.emit({ type: "incident.importance", payload: { incidentId, importance: { ...initial, stage: "opened", source: "rules", assessedAt: kit.now() } } });
  onOpened();
  if (!opened.ok) {
    kit.setAgent("commander", "done", `Could not open ${incidentId}: ${opened.reason}`);
    return;
  }
  // A critical alert is P1 from the start: page now, not after the investigation.
  await pageIfNeeded(kit, incidentId);

  kit.setStatus(incidentId, "investigating", "Investigator and Recovery Agent started in parallel");
  kit.setAgent("commander", "working", `Coordinating ${incidentId}`);
  // The investigation can fail; engineering still gets a ticket with what is known.
  await Promise.all([
    kit.tracer.span({ name: "investigate", kind: "node", actor: "investigator" }, () => investigate(kit, incidentId).catch(() => undefined)),
    kit.tracer.span({ name: "assess_impact", kind: "node", actor: "recovery" }, () => startRecovery(kit, incidentId)),
  ]);

  // Importance first, so the ticket is filed at the right priority, then the Issue Creator files it with the findings.
  await reassess(kit, incidentId, kit.state().incidents[incidentId]!.rootCause ? "root_cause" : "impact");
  await kit.tracer.span({ name: "file_engineering", kind: "node", actor: "issue_creator" }, () => fileIssue(kit, incidentId));
  kit.setStatus(incidentId, "recovering", "Planning a recovery for each affected customer");
  await kit.tracer.span({ name: "recover", kind: "node", actor: "commander" }, () => recover(kit, incidentId));
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
  await kit.serial(incidentId, async () => {
    await assessImpact(kit, incidentId);
    await reassess(kit, incidentId, "impact");
  });
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

/**
 * An alert on a service behind an open incident: it's already linked. The
 * Investigator weighs it (re-ranking without moving the incident back), and
 * the importance rules see it.
 */
export async function onAlertLinked(kit: AgentKit, incidentId: string): Promise<void> {
  await kit.serial(incidentId, async () => {
    if (kit.state().incidents[incidentId]!.hypotheses.length > 0) await investigate(kit, incidentId);
    await reassess(kit, incidentId, kit.state().incidents[incidentId]?.rootCause ? "root_cause" : "impact");
  });
}

/** After something outside a recovery pass changes a customer's recovery (a call ending): outcome notes, then the incident's status. */
export async function resettle(kit: AgentKit, incidentId: string): Promise<void> {
  await kit.serial(incidentId, async () => {
    await noteOutcomes(kit, incidentId, "handoff");
    await settle(kit, incidentId);
  });
}
