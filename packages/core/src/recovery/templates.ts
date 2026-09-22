import { SURFACE_LABELS, type Hypothesis, type IncidentView } from "@crisiscrew/contracts";

export type Draft = { subject: string; body: string; voiceScript: string; source: string };

const IST = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function clockTime(ms: number): string {
  return IST.format(ms);
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function inr(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

function causeSentence(root: Hypothesis | undefined): string {
  if (!root || root.kind === "unknown") return "We are still confirming the exact cause.";
  if (root.kind === "deploy") return "We've found the cause, a recent change to our checkout, and our team is fixing it now.";
  return `We've found the cause, a problem at our payment partner (${root.subject}), and we're working with them on it.`;
}

/**
 * One message for every affected customer, so everyone hears the same story.
 * `{name}` is replaced per customer. The refund line states general Indian
 * banking practice for failed payments, not a promise the system can't keep.
 */
export function draftUpdate(incident: IncidentView, since: number): Draft {
  const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  const area = SURFACE_LABELS[incident.surface].toLowerCase();
  const body =
    `Hi {name}, some payments in ${area} have been failing since about ${clockTime(since)}. ${causeSentence(root)} ` +
    "If money left your account for a payment that failed, your bank will reverse it automatically, so you don't need to pay again. " +
    `We're sorry for the trouble. Reference: ${incident.id}.`;
  const voiceScript =
    "Hello {name}, this is customer care. Some payments failed on our site today, including yours. " +
    `${root && root.kind !== "unknown" ? "We've found the cause and we're fixing it." : "We're looking into it now."} ` +
    "If money left your account, it will come back automatically. We're sorry, and there's nothing you need to do.";
  return { subject: `Update on your payment (${incident.id})`, body, voiceScript, source: "template" };
}

export function personalise(text: string, name: string): string {
  return text.replaceAll("{name}", firstName(name));
}

/** The case a human approver reads: what happened, how sure we are, what's been done, what's being asked. */
export function caseSummary(incident: IncidentView, amountInr: number, perCustomerInr: number, limitInr: number): string {
  const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  const evidence = root?.evidence.filter((e) => e.checked).map((e) => e.observation) ?? [];
  const affected = incident.affected;
  const sent = incident.updates.filter((u) => u.status === "sent").length;
  const voice = incident.updates.filter((u) => u.channel === "voice" && u.status !== "refused").length;
  const lines = [
    root
      ? `Root cause: ${root.label} (${Math.round((incident.rootCause?.confidence ?? 0) * 100)}% confidence). ${evidence.join("; ")}.`
      : "Root cause: not yet identified.",
    affected
      ? `Affected: ${affected.total} customers (${affected.ticketed.length} contacted us, ${affected.silent.length} haven't).`
      : "Affected customers: not yet identified.",
    `Done so far: ${incident.linkedTicketIds.length} tickets linked, ${sent} updates sent${voice ? `, ${voice} voice updates prepared` : ""}.`,
    `Proposed: ${inr(perCustomerInr)} goodwill credit for each affected customer = ${inr(amountInr)}, above the ${inr(limitInr)} limit the agents can approve alone.`,
    "Recommendation: approve, or modify the amount.",
  ];
  return lines.join("\n");
}

/** Plain-language summary of what the Investigator checked and concluded. */
export function investigationNarrative(hypotheses: Hypothesis[]): string {
  const top = hypotheses[0];
  if (!top) return "No hypotheses were produced.";
  const checks = new Set(hypotheses.flatMap((h) => h.evidence.filter((e) => e.checked).map((e) => e.source)));
  const checked = [
    checks.has("get_payment_health") && "the payment gateway",
    checks.has("get_recent_deployments") && "recent releases",
    checks.has("get_service_status") && "service error rates",
  ].filter(Boolean);
  const lead = `Checked ${checked.length ? checked.join(", ") : "nothing yet"}.`;
  if (top.kind === "unknown") return `${lead} No single cause stands out yet.`;
  const why = top.evidence.filter((e) => e.checked && e.lr > 1).map((e) => e.observation);
  return `${lead} Most likely cause: ${top.label} (${Math.round(top.confidence * 100)}%)${why.length ? `, because ${why.join("; ")}` : ""}.`;
}
