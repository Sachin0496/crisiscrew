import {
  incidentTitle,
  SURFACE_LABELS,
  type AffectedCustomer,
  type Alert,
  type Coverage,
  type Hypothesis,
  type ImportanceAssessment,
  type IncidentView,
  type RecoveryAction,
  type Surface,
} from "@crisiscrew/contracts";

/**
 * The incident's messages, one per outreach track so everyone hears the same
 * story told to where they stand. Placeholders are filled per customer by
 * fillOutreach: {name}, {ticket}, {payment} and {credit}.
 */
export type Draft = {
  subject: string;
  /** Complained track: the reply on the customer's own ticket. */
  complained: string;
  /** Not-complained track: the proactive message about a failure they may not have noticed. */
  notComplained: string;
  /** Unverified complaints: thanks, and a request for a payment reference. */
  acknowledgement: string;
  voice: { complained: string; notComplained: string };
  source: string;
};

const IST = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const IST_SECONDS = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function clockTime(ms: number): string {
  return IST.format(ms);
}

export function clockTimeSec(ms: number): string {
  return IST_SECONDS.format(ms);
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function inr(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

function causeSentence(root: Hypothesis | undefined): string {
  if (!root || root.kind === "unknown") return "We are still confirming the exact cause.";
  if (root.kind === "deploy") return "We've found the cause, a recent change on our side, and our team is fixing it now.";
  if (root.kind === "infra") return "We've found the cause, a problem with our own systems, and our team is fixing it now.";
  return `We've found the cause, a problem at our payment partner (${root.subject}), and we're working with them on it.`;
}

/** What went wrong, in the customer's words, for each product area. */
const PROBLEM: Record<Surface, string> = {
  checkout_payments: "some payments at checkout have been failing",
  login_account: "some customers haven't been able to sign in",
  delivery_orders: "some orders have run into delivery problems",
  refunds_billing: "some refunds and charges have gone wrong",
  app_performance: "our app has been slow or failing to load",
  other: "some customers have hit a problem with our service",
};

/**
 * One message for every affected customer, so everyone hears the same story.
 * `{name}` is replaced per customer. The refund line states general Indian
 * banking practice for failed payments, not a promise the system can't keep.
 */
export function draftUpdate(incident: IncidentView, since: number): Draft {
  const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  const refund = "If money left your account for a payment that failed, your bank will reverse it automatically, so you don't need to pay again.";
  const complained =
    `Hi {name}, thanks for writing in (ticket {ticket}). You're right: ${PROBLEM[incident.surface]} since about ${clockTime(since)}, and {payment} was one of them. ` +
    `${causeSentence(root)} ${refund} {credit}We're sorry for the trouble. Reference: ${incident.id}.`;
  const notComplained =
    `Hi {name}, you may not have noticed, but {payment} didn't go through. ${capitalise(PROBLEM[incident.surface])} since about ${clockTime(since)}. ` +
    `${causeSentence(root)} ${refund} {credit}We're sorry for the trouble. Reference: ${incident.id}.`;
  const fixing = root && root.kind !== "unknown" ? "We've found the cause and we're fixing it." : "We're looking into it now.";
  const voice = {
    complained:
      "Hello {name}, this is customer care, calling about the ticket you raised. You were right: your payment failed because of a problem on our side. " +
      `${fixing} If money left your account, it will come back automatically. {credit}We're sorry, and there's nothing more you need to do.`,
    notComplained:
      "Hello {name}, this is customer care. You may not have noticed, but {payment} didn't go through today. " +
      `${fixing} If money left your account, it will come back automatically. {credit}We're sorry, and there's nothing you need to do.`,
  };
  const subject = incident.surface === "checkout_payments" ? `Update on your payment (${incident.id})` : `Update from customer care (${incident.id})`;
  const reference =
    incident.surface === "checkout_payments"
      ? "We couldn't find a failed payment on your account yet. If money left your account, reply with your order number or payment reference and we'll check it for you."
      : "We couldn't match your account to the problem yet. Reply with your order number or account email and we'll check it for you.";
  const acknowledgement =
    `Hi {name}, thanks for telling us. We know ${PROBLEM[incident.surface]} since about ${clockTime(since)}, and our team is on it. ${reference} ` +
    `Reference: ${incident.id}.`;
  return { subject, complained, notComplained, acknowledgement, voice, source: "template" };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const METHOD_WORDS: Record<string, string> = { upi: "UPI", card: "card", netbanking: "netbanking", wallet: "wallet" };

/**
 * Fills one message for one customer. {payment} is their own failed
 * payment ("your ₹12,999 card payment at 13:25"); {credit} says a credit is
 * being reviewed when one waits for a human, and never names an amount
 * before a human approves it.
 */
export function fillOutreach(
  text: string,
  customer: Pick<AffectedCustomer, "name" | "amountInr" | "methods" | "lastFailedAt">,
  extra: { ticket?: string; creditUnderReview?: boolean } = {},
): string {
  const method = METHOD_WORDS[customer.methods[0] ?? ""] ?? "";
  const payment =
    customer.amountInr > 0
      ? `your ${inr(customer.amountInr)}${method ? ` ${method}` : ""} payment${customer.lastFailedAt !== undefined ? ` at ${clockTime(customer.lastFailedAt)}` : ""}`
      : "your payment";
  return text
    .replaceAll("{name}", firstName(customer.name))
    .replaceAll("{ticket}", extra.ticket ?? "your ticket")
    .replaceAll("{payment}", payment)
    .replaceAll("{credit}", extra.creditUnderReview ? "We're also reviewing a goodwill credit for you and will confirm it shortly. " : "");
}

const DONE_PHRASES: Partial<Record<RecoveryAction["kind"], string>> = {
  ticket_reply: "update sent on their ticket",
  acknowledge: "acknowledged, and asked for a payment reference",
  proactive_message: "proactive update sent",
  account_note: "note left on their account",
};

/** What has been done for one customer, in a phrase per action. */
export function actionPhrases(actions: RecoveryAction[]): string[] {
  return actions.flatMap((a) => {
    if (a.kind === "voice") {
      if (a.status === "prepared") return ["voice update prepared (voice is off)"];
      if (a.status === "calling") return ["phone call in progress"];
      if (a.status === "unreached") return [`not reached by phone after ${a.attempts ?? 1} ${(a.attempts ?? 1) === 1 ? "call" : "calls"}`];
      return a.status === "done" ? [a.callId ? "phone call answered" : "voice update sent"] : [];
    }
    if (a.kind === "credit") {
      if (a.status === "done") return [`${inr(a.amountInr ?? 0)} goodwill credit issued${a.approvalId ? ` on approval ${a.approvalId}` : ""}${a.detail ? ` (${a.detail})` : ""}`];
      if (a.status === "declined") return [`credit declined by the approver${a.detail ? `: ${a.detail}` : ""}`];
      if (a.status === "awaiting_approval") return [`${inr(a.amountInr ?? 0)} credit waiting for a human decision`];
      return [];
    }
    if (a.kind === "no_credit") return [`no credit: ${a.reason.charAt(0).toLowerCase()}${a.reason.slice(1)}`];
    const phrase = DONE_PHRASES[a.kind];
    return phrase && a.status === "done" ? [phrase] : [];
  });
}

function evidenceSentence(customer: AffectedCustomer): string {
  const facts = customer.evidence.filter((e) => e.kind === "payment_failed" || e.kind === "payment_pending" || e.kind === "payment_succeeded").map((e) => e.label);
  return facts.length ? facts.join("; ") : "no failed payment on record";
}

/** The case a human approver reads for one customer's credit: the evidence, the cause, what's been done, and what's asked. */
export function customerCase(incident: IncidentView, customer: AffectedCustomer, actions: RecoveryAction[], credit: RecoveryAction, perCustomerLimitInr: number): string {
  const root = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
  const done = actionPhrases(actions.filter((a) => a.id !== credit.id));
  const lines = [
    `${customer.name}${customer.tier === "priority" ? ", a priority customer" : ""}, ${customer.complained ? "wrote in" : "never contacted support"}. Evidence: ${evidenceSentence(customer)}.`,
    root ? `Likely cause: ${root.label} (${Math.round((incident.rootCause?.confidence ?? 0) * 100)}% confidence).` : "Cause: not identified yet.",
    done.length ? `Done so far: ${done.join("; ")}.` : "Nothing sent yet.",
    `Proposed: ${inr(credit.amountInr ?? 0)} goodwill credit, above the ${inr(perCustomerLimitInr)} the agents may give one customer on their own.`,
    "Approve, change the amount, or reject. Only the amount you approve can be paid, and only to this customer.",
  ];
  return lines.join("\n");
}

/** The private note CrisisCrew leaves on a customer's ticket once their recovery is settled. */
export function outcomeNote(incident: IncidentView, customer: AffectedCustomer, actions: RecoveryAction[]): string {
  const cause = incident.rootCause ? `; likely cause ${incident.rootCause.label} (${Math.round(incident.rootCause.confidence * 100)}%)` : "";
  return [
    `CrisisCrew · ${incident.id} · ${incidentTitle(incident.surface)}`,
    `${customer.confidence === "confirmed" ? "Confirmed affected" : "Not verified"}: ${evidenceSentence(customer)}${cause}.`,
    `Recovery: ${actionPhrases(actions).join("; ") || "nothing yet"}.`,
  ].join("\n");
}

/** The engineering incident's title and first description, from the detection. */
export function engineeringSummary(incident: IncidentView, alert?: Pick<Alert, "service" | "label">): { title: string; description: string } {
  if (alert) {
    return {
      title: `${incidentTitle(incident.surface)} (${incident.id})`,
      description:
        `CrisisCrew opened ${incident.id} from a critical alert on ${alert.service}: ${alert.label}. ` +
        "It is finding the customers whose payments failed, whether or not they write in. Customer impact and recovery are tracked in CrisisCrew, and notes follow here.",
    };
  }
  return {
    title: `${incidentTitle(incident.surface)} (${incident.id})`,
    description:
      `CrisisCrew opened ${incident.id}: ${incident.ticketIds.length} similar failure reports about ${SURFACE_LABELS[incident.surface].toLowerCase()} ` +
      "passed every detection gate. Customer impact and recovery are tracked in CrisisCrew, and notes follow here.",
  };
}

/** The note that brings the engineering incident up to date on customer impact. */
export function coverageNote(coverage: Coverage): string {
  const pct = coverage.ratio === null ? "n/a" : `${Math.round(coverage.ratio * 100)}%`;
  return (
    `Customer impact: ${coverage.confirmed} customers affected (${coverage.complained} complained, ${coverage.silent} silent` +
    `${coverage.unverified ? `; ${coverage.unverified} more complained without a failed payment on record` : ""}). ` +
    `Recovery coverage ${coverage.recovered}/${coverage.confirmed} (${pct})${coverage.needsHuman ? `; ${coverage.needsHuman} waiting for a human decision` : ""}.`
  );
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
    checks.has("get_infra_health") && "infrastructure (pods and cloud alarms)",
  ].filter(Boolean);
  const lead = `Checked ${checked.length ? checked.join(", ") : "nothing yet"}.`;
  if (top.kind === "unknown") return `${lead} No single cause stands out yet.`;
  const why = top.evidence.filter((e) => e.checked && e.lr > 1).map((e) => e.observation);
  return `${lead} Most likely cause: ${top.label} (${Math.round(top.confidence * 100)}%)${why.length ? `, because ${why.join("; ")}` : ""}.`;
}

/** The engineering note for a change of importance: the level, whether to page, and every reason. */
export function importanceNote(importance: ImportanceAssessment): string {
  const who = importance.source === "human" ? `Set by ${importance.by ?? "a human"}${importance.note ? `: “${importance.note}”` : ""}` : "Raised by the Incident Commander's rules";
  const reasons = importance.reasons.map((r) => `- ${r.level}: ${r.text}`).join("\n");
  return `Importance ${importance.level}${importance.page ? " (page on-call)" : ""}. ${who}.${reasons ? `\n${reasons}` : ""}`;
}

/** What the on-call engineer hears: which incident, how bad, and the likely cause. Short, because it's read aloud. */
export function pageScript(incident: IncidentView, responder?: string): string {
  const confirmed = incident.impact?.customers.filter((c) => c.confidence === "confirmed").length ?? 0;
  const id = incident.id.replace(/-/g, " ");
  // Short on purpose: a page is heard on a phone, often half awake, and the engineer can ask for more.
  const area = SURFACE_LABELS[incident.surface].replace("&", "and").toLowerCase();
  return [
    `${responder ? `Hi ${responder.split(/\s+/)[0]}, ` : ""}CrisisCrew here, with a ${incident.importance?.level ?? ""} incident, ${id}.`,
    confirmed > 0 ? `${area[0]!.toUpperCase()}${area.slice(1)} is failing for ${confirmed} ${confirmed === 1 ? "customer" : "customers"}.` : `${area[0]!.toUpperCase()}${area.slice(1)} is failing.`,
    incident.rootCause ? `Likely cause: ${incident.rootCause.label}, ${Math.round(incident.rootCause.confidence * 100)} percent.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The engineering note for one page: who was called, and how it ended. */
export function pageNote(attempt: { attempt: number; responder: string; role: string; state: string; reason?: string }, via?: string): string {
  const outcome: Record<string, string> = {
    calling: "calling now",
    acknowledged: `acknowledged${via === "operator" ? "" : " by pressing 1"}`,
    not_acknowledged: "answered but didn't acknowledge",
    no_answer: "no answer",
    busy: "line busy",
    failed: `call failed${attempt.reason ? `: ${attempt.reason}` : ""}`,
  };
  return `On-call page ${attempt.attempt}: ${attempt.responder} (${attempt.role}), ${outcome[attempt.state] ?? attempt.state}.`;
}

const pctOf = (n: number) => `${Math.round(n * 100)}%`;

/**
 * The engineering ticket's description, written once the investigation has
 * ranked the causes: the likely cause and every factor behind it, the other
 * causes considered, what to look at (the release or the infrastructure),
 * customer impact so far, who's on call, and where to follow it in CrisisCrew.
 */
export function engineeringTicket(
  incident: IncidentView,
  context: { alert?: Pick<Alert, "service" | "label">; paging?: IncidentView["paging"]; links?: { incident: string; audit: string } },
): { title: string; description: string } {
  const { title } = engineeringSummary(incident, context.alert);
  const opened = context.alert
    ? `a critical alert on ${context.alert.service}: ${context.alert.label}`
    : `${incident.ticketIds.length} similar failure reports that passed every detection gate`;
  const lines = [`CrisisCrew opened ${incident.id} (${incident.importance?.level ?? "P2"}) from ${opened}.`, ""];

  const top = incident.hypotheses[0];
  if (incident.rootCause && top) {
    lines.push(`Likely cause: ${incident.rootCause.label} (${pctOf(incident.rootCause.confidence)} confidence)`);
    for (const e of top.evidence) lines.push(`  - ${e.observation} (×${e.lr.toFixed(2)}${e.checked ? "" : ", not checked"})`);
    if (top.kind === "deploy") {
      const release = top.evidence.find((e) => e.source === "get_recent_deployments")?.observation.match(/\(([0-9a-f]{7}) by ([^:]+):/);
      lines.push(`Suspected change: ${top.label}${release ? `, commit ${release[1]} by ${release[2]}` : ""}. A rollback change request follows when the confidence allows.`);
    } else if (top.kind === "infra") {
      lines.push(`Look at: ${top.subject}'s pods and cloud alarms (the factors above).`);
    }
  } else {
    lines.push("No single cause stands out yet. Causes considered:");
  }
  const others = incident.hypotheses.filter((h) => h.id !== incident.rootCause?.hypothesisId).map((h) => `${h.label} (${pctOf(h.confidence)})`);
  if (others.length) lines.push(`${incident.rootCause ? "Also considered" : ""}${incident.rootCause ? ": " : "  "}${others.join(", ")}.`);

  const confirmed = incident.impact?.customers.filter((c) => c.confidence === "confirmed") ?? [];
  if (incident.impact) {
    const silent = confirmed.filter((c) => !c.complained).length;
    const value = confirmed.reduce((sum, c) => sum + c.amountInr, 0);
    lines.push("", `Customer impact so far: ${confirmed.length} confirmed affected (${confirmed.length - silent} complained, ${silent} silent), ${inr(value)} in failed or pending payments.`);
  }
  if (context.paging) {
    const p = context.paging;
    lines.push(`On-call: ${p.status === "acknowledged" ? `acknowledged by ${p.acknowledgedBy}` : p.status === "paging" ? `paging ${p.attempts.at(-1)?.responder ?? "the on-call engineer"}` : (p.note ?? p.status.replace(/_/g, " "))}.`);
    // Pages made before the ticket existed, so their history isn't lost.
    for (const a of p.attempts) lines.push(`  - ${pageNote(a, p.acknowledgedBy === a.responder ? p.via : undefined)}`);
  }
  if (context.links) lines.push("", `Follow it in CrisisCrew: ${context.links.incident}`, `Every agent action, hash-chained: ${context.links.audit}`);
  return { title, description: lines.join("\n") };
}

/** The rollback change request: which release, why, and that a human decides. */
export function rollbackChange(incident: IncidentView): { title: string; description: string } {
  const top = incident.hypotheses[0]!;
  return {
    title: `Roll back ${top.label} (${incident.id})`,
    description: [
      `${incident.id}: ${top.label} is the likely cause of ${SURFACE_LABELS[incident.surface].toLowerCase()} failures (${pctOf(top.confidence)} confidence).`,
      ...top.evidence.map((e) => `  - ${e.observation}`),
      "",
      "Requested by CrisisCrew's Issue Creator as an option for engineering to plan and approve. CrisisCrew doesn't roll anything back.",
    ].join("\n"),
  };
}

/** The problem record for the post-incident review: what happened, who was affected, how they were recovered. */
export function problemRecord(incident: IncidentView, coverage: Coverage): { title: string; description: string } {
  return {
    title: `Post-incident review: ${incidentTitle(incident.surface).toLowerCase()} (${incident.id})`,
    description: [
      `${incident.id} is recovered: every one of the ${coverage.confirmed} affected customers has a completed or human-decided recovery.`,
      incident.rootCause ? `Likely cause: ${incident.rootCause.label} (${pctOf(incident.rootCause.confidence)} confidence).` : "The cause wasn't settled by the investigation.",
      `Affected: ${coverage.confirmed} (${coverage.complained} complained, ${coverage.silent} silent).`,
      "",
      "Opened by CrisisCrew's Issue Creator for the post-incident review: confirm the cause, and plan the work that stops it happening again.",
    ].join("\n"),
  };
}

/**
 * The bounded menu after a customer call's script, and what the call says
 * back for each key. It answers with facts CrisisCrew holds, and never
 * promises a credit it hasn't issued: an issued credit is named with its
 * amount, one under review without.
 */
export function callMenu(customer: Pick<AffectedCustomer, "name" | "amountInr" | "methods" | "lastFailedAt" | "paidOnRetry">, credit?: RecoveryAction): { prompt: string; replies: Record<string, string> } {
  const payment = fillOutreach("{payment}", customer);
  const status = customer.paidOnRetry
    ? `${capitalise(payment)} went through on a later try, so there's nothing more to pay.`
    : `${capitalise(payment)} didn't go through. If money left your account, your bank will reverse it automatically.`;
  const creditLine =
    credit?.status === "done"
      ? ` A goodwill credit of ${inr(credit.amountInr ?? 0)} has been added to your account.`
      : credit && (credit.status === "planned" || credit.status === "awaiting_approval")
        ? " A goodwill credit for you is being reviewed, and we'll confirm it shortly."
        : "";
  return {
    prompt: "Press 1 to hear the status of your payment, 2 to have a person call you back, or 3 to stop these calls.",
    replies: {
      "1": `${status}${creditLine} Thank you, goodbye.`,
      "2": "Thank you. Someone from our team will call you back. Goodbye.",
      "3": "Understood. We won't call you about this again. Goodbye.",
    },
  };
}

const PRESSED: Record<string, string> = {
  "1": "pressed 1 and heard their payment and credit status",
  "2": "pressed 2: asked for a person to call them back",
  "3": "pressed 3: asked not to be called again, so voice consent is withdrawn",
};

/** The note written after a customer call ends: when, how long, and what they chose. */
export function callNote(incidentId: string, customer: Pick<AffectedCustomer, "name">, outcome: { answered: boolean; durationSec?: number; digits?: string; attempts: number; reason?: string }): string {
  if (!outcome.answered) {
    return `CrisisCrew · ${incidentId} · ${customer.name} wasn't reached by phone after ${outcome.attempts} ${outcome.attempts === 1 ? "call" : "calls"}${outcome.reason ? ` (${outcome.reason})` : ""}. The written update stands.`;
  }
  const choice = outcome.digits ? PRESSED[outcome.digits[0]!] ?? `pressed ${outcome.digits}` : "listened, and pressed nothing";
  return `CrisisCrew · ${incidentId} · Called ${customer.name}${outcome.durationSec !== undefined ? ` (${outcome.durationSec} s)` : ""}: answered, ${choice}.${outcome.digits?.startsWith("2") ? " Please call them back." : ""}`;
}
