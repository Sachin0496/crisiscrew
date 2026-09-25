import { outreachTrack, type AffectedCustomer, type Level, type Policy, type RecoveryAction, type RecoveryKind } from "@crisiscrew/contracts";
import { clockTimeSec, inr } from "./templates";

export type PlanInput = {
  incidentId: string;
  customers: AffectedCustomer[];
  /** Actions already planned for this incident; planning never repeats or replaces them. */
  existing: RecoveryAction[];
  policy: Pick<Policy, "limits" | "recovery">;
  now: number;
  nextId: () => string;
};

/**
 * The recovery policy, customer by customer. Each action says why the policy
 * chose it and what authority it needs. Planning is idempotent: it adds only
 * the actions a customer doesn't have yet, so it can run again when a silent
 * customer writes in or a new customer turns up.
 *
 * Outreach follows the customer's track. Complained: a reply on their
 * ticket, and a call when they're a priority customer or lost a large
 * payment. Not complained: a proactive message (or, if they opted out, only
 * a note on their account), and a call whenever they agreed to calls. The
 * gate checks consent again when each is sent.
 *
 * Credits are sized by the harm, not handed out per ticket. The agents may
 * give one customer up to the per-customer limit and the whole incident up
 * to the authority limit; customers are planned in order, so the first
 * credit that would cross either limit goes to a human, and the agents can't
 * split a payout to get past it.
 */
export function planRecovery(input: PlanInput): RecoveryAction[] {
  const { limits, recovery } = input.policy;
  let committed = input.existing
    .filter((a) => a.kind === "credit" && a.level === 2 && (a.status === "planned" || a.status === "done"))
    .reduce((sum, a) => sum + (a.amountInr ?? 0), 0);
  const added: RecoveryAction[] = [];

  for (const c of input.customers) {
    const have = new Set(input.existing.filter((a) => a.customerRef === c.ref).map((a) => a.kind));
    const track = outreachTrack(c);
    const add = (kind: RecoveryKind, reason: string, level: Level | null, amountInr?: number) => {
      if (have.has(kind)) return;
      have.add(kind);
      added.push({
        id: input.nextId(),
        incidentId: input.incidentId,
        customerRef: c.ref,
        kind,
        reason,
        level,
        ...(amountInr !== undefined ? { amountInr } : {}),
        ...(kind === "credit" || kind === "no_credit" ? {} : { track }),
        status: kind === "no_credit" ? "done" : "planned",
        updatedAt: input.now,
      });
    };

    if (c.confidence !== "confirmed") {
      // A complaint without a failed payment on record: answer it, but never credit or contact proactively on the ticket alone.
      if (c.complained) add("acknowledge", "Wrote in, but no failed payment is on record: acknowledge and ask for the payment reference. No credit without evidence", 2);
      continue;
    }

    const high = c.severity === "high";
    if (track === "complained") {
      add("ticket_reply", "Wrote in, so the update goes on their ticket", 2);
      if (c.consent.voice && (c.tier === "priority" || high)) {
        add("voice", c.tier === "priority" ? "Priority customer who wrote in and agreed to calls" : `Wrote in about a ${inr(c.amountInr)} payment and agreed to calls`, 2);
      }
    } else {
      if (c.consent.proactive) add("proactive_message", "Didn't write in, and agreed to proactive messages", 2);
      else add("account_note", "Didn't write in and opted out of proactive messages, so nobody messages them. A note on their account tells support what happened", 1);
      if (c.consent.voice) add("voice", c.tier === "priority" ? "Priority customer who didn't write in and agreed to calls" : "Didn't write in, and agreed to calls", 2);
    }

    if (have.has("credit") || have.has("no_credit")) continue;
    if (c.paidOnRetry) {
      add("no_credit", `Paid on a retry${c.lastFailedAt !== undefined ? ` after the failure at ${clockTimeSec(c.lastFailedAt)}` : ""}, so the update is enough`, null);
      continue;
    }
    const amount = high ? recovery.creditInr.high : recovery.creditInr.standard;
    if (amount <= 0) {
      add("no_credit", "The recovery policy sets no credit for this harm", null);
      continue;
    }
    const why = !high
      ? "Payment failed during the incident"
      : c.tier === "priority"
        ? "Priority customer whose payment failed"
        : `Lost a ${inr(c.amountInr)} payment (${inr(recovery.highValueInr)} or more)`;
    if (amount > limits.perCustomerLimitInr) {
      add("credit", `${why}: ${inr(amount)} goodwill credit, above the ${inr(limits.perCustomerLimitInr)} the agents may give one customer, so a human decides`, 3, amount);
    } else if (committed + amount > limits.authorityLimitInr) {
      add(
        "credit",
        `${why}: ${inr(amount)} goodwill credit. The agents have already committed ${inr(committed)} of the ${inr(limits.authorityLimitInr)} they may spend on this incident, so a human decides`,
        3,
        amount,
      );
    } else {
      committed += amount;
      add("credit", `${why}: ${inr(amount)} goodwill credit, within the agents' authority`, 2, amount);
    }
  }
  return added;
}
