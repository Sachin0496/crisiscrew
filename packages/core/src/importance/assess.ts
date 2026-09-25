import { SURFACE_LABELS, type ImportanceAssessment, type ImportanceConfig, type ImportanceLevel, type ImportanceReason, type IncidentView } from "@crisiscrew/contracts";

/** An operational alert on a service behind the incident (Freshservice Alert Management, once it's wired). */
export type ImportanceAlert = { severity: "critical" | "warning"; service: string; label: string };

const RANK: Record<ImportanceLevel, number> = { P1: 1, P2: 2, P3: 3 };

/** True when a is more urgent than b. */
export const higher = (a: ImportanceLevel, b: ImportanceLevel) => RANK[a] < RANK[b];

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * How important an incident is, from what's known so far. Every rule that
 * fires adds a reason; the level is the most urgent one, and P3 when none
 * fires. Pure and deterministic: the same incident and policy always give
 * the same answer.
 */
export function assessImportance(
  incident: Pick<IncidentView, "surface" | "impact" | "rootCause" | "hypotheses">,
  alerts: readonly ImportanceAlert[],
  config: ImportanceConfig,
): Pick<ImportanceAssessment, "level" | "page" | "reasons"> {
  const reasons: ImportanceReason[] = [];
  const add = (rule: string, level: ImportanceLevel, text: string) => reasons.push({ rule, level, text });
  const tiered = (rule: string, value: number, tiers: { p1: number; p2: number }, text: string, show: (n: number) => string) => {
    if (value >= tiers.p1) add(rule, "P1", `${text} (${show(tiers.p1)} or more is P1)`);
    else if (value >= tiers.p2) add(rule, "P2", `${text} (${show(tiers.p2)} or more is P2)`);
  };

  for (const alert of alerts) {
    add("alert", alert.severity === "critical" ? "P1" : "P2", `${alert.severity === "critical" ? "Critical" : "Warning"} alert on ${alert.service}: ${alert.label}`);
  }

  const confirmed = (incident.impact?.customers ?? []).filter((c) => c.confidence === "confirmed");
  if (incident.impact) {
    tiered("affected_customers", confirmed.length, config.affectedCustomers, `${plural(confirmed.length, "customer")} affected`, String);
    const value = confirmed.reduce((sum, c) => sum + c.amountInr, 0);
    tiered("failed_value", value, config.failedValueInr, `${inr(value)} in failed or pending payments`, inr);
    const priority = confirmed.filter((c) => c.tier === "priority").length;
    tiered("priority_customers", priority, config.priorityCustomers, `${plural(priority, "priority customer")} affected`, String);
  }

  if (config.tier1Surfaces.includes(incident.surface)) {
    add("tier1_surface", "P2", `${SURFACE_LABELS[incident.surface]} is a tier-1 area`);
  }

  const cause = incident.rootCause && incident.hypotheses.find((h) => h.id === incident.rootCause!.hypothesisId);
  if (cause?.kind === "deploy" && incident.rootCause!.confidence >= config.deployConfidence) {
    add("deploy_cause", "P2", `${incident.rootCause!.label} is the likely cause (${Math.round(incident.rootCause!.confidence * 100)}%), so a rollback is an option`);
  }

  reasons.sort((a, b) => RANK[a.level] - RANK[b.level]);
  const level = reasons[0]?.level ?? "P3";
  return { level, page: RANK[level] <= RANK[config.pageAt], reasons };
}

/**
 * What the incident's importance becomes after a new assessment by the
 * rules. It only goes up on its own: a lower result keeps the current level.
 * An equal one refreshes the reasons, since it knows more. A human's
 * decision stands until another human changes it. Returns null when nothing
 * changes.
 */
export function nextImportance(current: ImportanceAssessment | undefined, assessed: ImportanceAssessment): ImportanceAssessment | null {
  if (!current) return assessed;
  if (current.source === "human") return null;
  if (higher(assessed.level, current.level)) return assessed;
  if (assessed.level !== current.level) return null;
  const same = JSON.stringify(current.reasons) === JSON.stringify(assessed.reasons) && current.page === assessed.page;
  return same ? null : assessed;
}
