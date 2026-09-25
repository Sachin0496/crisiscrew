import type { AgentKit } from "./kit";

/**
 * Issue Creator: files the incident where engineering works (Freshservice,
 * or its sandbox) once the Investigator has ranked the causes, so the ticket
 * leads with what was found rather than a placeholder. When a release is the
 * likely cause with high confidence it adds a rollback change request for a
 * human to plan and approve; once the incident is recovered it opens a
 * problem record for the post-incident review. It can write records, never
 * act on systems.
 */
export async function fileIssue(kit: AgentKit, incidentId: string): Promise<void> {
  kit.setAgent("issue_creator", "working", `Filing ${incidentId} for engineering with the investigation's findings`);
  const filed = await kit.gate.call("issue_creator", "file_engineering_incident", { incidentId });
  if (!filed.ok) {
    kit.setAgent("issue_creator", "done", `Not filed: ${filed.reason}`);
    return;
  }
  const incident = kit.state().incidents[incidentId]!;
  const record = incident.engineering!;
  // Only a release blamed with enough confidence gets a rollback request; the gate checks the same again.
  const top = incident.hypotheses[0];
  const blamed = top?.kind === "deploy" && incident.rootCause?.hypothesisId === top.id && top.confidence >= kit.policy.issues.rollbackConfidence;
  const rollback = blamed ? await kit.gate.call("issue_creator", "request_rollback_change", { incidentId }) : null;
  const change = rollback?.ok ? `; rollback change ${(rollback.result as { id: string }).id} requested` : "";
  kit.setAgent("issue_creator", "done", `Filed ${incidentId} as ${record.id}${change}`);
}

/** The post-incident review's problem record, once every affected customer is recovered. */
export async function openProblem(kit: AgentKit, incidentId: string): Promise<void> {
  if (!kit.policy.issues.problemOnRecovered) return;
  const r = await kit.gate.call("issue_creator", "open_problem_record", { incidentId });
  if (r.ok) kit.setAgent("issue_creator", "done", `Opened problem ${(r.result as { id: string }).id} for ${incidentId}'s post-incident review`);
}
