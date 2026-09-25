import { parsePolicy, TOOL_NAMES, type AffectedCustomer, type Customer, type RecoveryAction, type Ticket } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import policyJson from "../../../../config/policy.json";
import type { PaymentAttempt } from "../ports";
import { assessImpact, severityOf } from "./impact";
import { planRecovery } from "./plan";
import { fillOutreach } from "./templates";

const policy = parsePolicy(policyJson, TOOL_NAMES);
const T0 = Date.UTC(2026, 8, 25, 8, 42, 0);
const S = 1_000;

function customer(ref: string, over: Partial<Customer> = {}): Customer {
  return { ref, name: ref.toUpperCase(), tier: "standard", consent: { proactive: true, voice: false }, ...over };
}

function attempt(customerRef: string, sec: number, status: PaymentAttempt["status"], amountInr = 999, method: PaymentAttempt["method"] = "upi"): PaymentAttempt {
  return { customerRef, at: T0 + sec * S, status, amountInr, method };
}

function ticket(id: string, customerRef: string, sec: number, body = "Checkout keeps failing"): Ticket {
  return { id, source: "sandbox", customerRef, customerName: customerRef, channel: "chat", body, receivedAt: T0 + sec * S };
}

const assess = (tickets: Ticket[], attempts: PaymentAttempt[], customers: Customer[], since = T0 - 600 * S) =>
  assessImpact({
    incidentId: "INC-1",
    tickets,
    attempts,
    customers: new Map(customers.map((c) => [c.ref, c])),
    since,
    services: ["checkout-service"],
    cause: { id: "deploy:checkout-service@4.21.7", label: "checkout-service v4.21.7", confidence: 0.97, startedAt: since },
    highValueInr: 10_000,
    ordersSource: "sandbox",
  });

describe("assessImpact", () => {
  it("confirms a customer from a failed payment in the window, whether or not they wrote in", () => {
    const [priya, arun] = assess(
      [ticket("T-1004", "priya", 45)],
      [attempt("priya", 40, "failed", 649, "card"), attempt("arun", 20, "failed", 999)],
      [customer("priya", { name: "Priya K." }), customer("arun", { name: "Arun" })],
    );
    expect(priya).toMatchObject({ ref: "priya", complained: true, confidence: "confirmed", severity: "medium", ticketIds: ["T-1004"], amountInr: 649 });
    expect(arun).toMatchObject({ ref: "arun", complained: false, confidence: "confirmed" });
    expect(priya?.evidence.map((e) => e.kind)).toEqual(["payment_failed", "service", "cause", "window", "reported"]);
    expect(arun?.evidence.map((e) => e.kind)).toEqual(["payment_failed", "service", "cause", "window", "no_ticket"]);
    expect(priya?.evidence[0]).toMatchObject({ label: "Card payment of ₹649 failed at 14:12:40", node: `attempt:priya:${T0 + 40 * S}`, source: "sandbox" });
    expect(priya?.evidence[4]?.label).toBe("Opened T-1004 at 14:12:45: “Checkout keeps failing”");
  });

  it("keeps a complaint without a failed payment as unverified, and never infers harm from the ticket", () => {
    const [judge] = assess([ticket("T-1009", "walk-in:judge", 90)], [], []);
    expect(judge).toMatchObject({ confidence: "unverified", complained: true, failedAttempts: 0 });
    expect(judge?.severity).toBeUndefined();
    expect(judge?.evidence.map((e) => e.kind)).toEqual(["no_payment", "reported"]);
  });

  it("leaves out customers whose payments all went through, and failures from before the window", () => {
    const customers = assess([], [attempt("ok", 10, "success"), attempt("early", -700, "failed")], [customer("ok"), customer("early")]);
    expect(customers).toEqual([]);
  });

  it("marks a customer who paid on a later retry as low severity, with the retry as evidence", () => {
    const [nisha] = assess([], [attempt("nisha", -480, "pending", 1_099, "card"), attempt("nisha", -240, "success", 1_099, "card")], [customer("nisha")]);
    expect(nisha).toMatchObject({ paidOnRetry: true, severity: "low" });
    expect(nisha?.evidence.map((e) => e.kind)).toContain("payment_succeeded");
  });

  it("rates priority customers and large failed payments as high severity", () => {
    expect(severityOf({ tier: "priority", amountInr: 500, paidOnRetry: false }, 10_000)).toBe("high");
    expect(severityOf({ tier: "standard", amountInr: 12_999, paidOnRetry: false }, 10_000)).toBe("high");
    expect(severityOf({ tier: "standard", amountInr: 9_999, paidOnRetry: false }, 10_000)).toBe("medium");
    expect(severityOf({ tier: "priority", amountInr: 12_999, paidOnRetry: true }, 10_000)).toBe("low");
  });

  it("lists complainers first, then silent customers by first failure, then the unverified", () => {
    const order = assess(
      [ticket("T-2", "b", 60), ticket("T-1", "a", 50), ticket("T-3", "x", 70)],
      [attempt("a", 40, "failed"), attempt("b", 30, "failed"), attempt("s2", 20, "failed"), attempt("s1", 10, "pending")],
      ["a", "b", "s1", "s2"].map((r) => customer(r)),
    ).map((c) => c.ref);
    expect(order).toEqual(["a", "b", "s1", "s2", "x"]);
  });
});

function affected(ref: string, over: Partial<AffectedCustomer> = {}): AffectedCustomer {
  return {
    ref,
    name: ref,
    tier: "standard",
    consent: { proactive: true, voice: false },
    complained: false,
    ticketIds: [],
    confidence: "confirmed",
    severity: "medium",
    failedAttempts: 1,
    amountInr: 999,
    methods: ["upi"],
    paidOnRetry: false,
    evidence: [],
    ...over,
  };
}

function plan(customers: AffectedCustomer[], existing: RecoveryAction[] = [], limits = policy.limits) {
  let n = existing.length;
  return planRecovery({ incidentId: "INC-1", customers, existing, policy: { ...policy, limits }, now: T0, nextId: () => `RA-${++n}` });
}

const kinds = (actions: RecoveryAction[], ref: string) => actions.filter((a) => a.customerRef === ref).map((a) => `${a.kind}${a.amountInr ? `:${a.amountInr}` : ""}:L${a.level ?? "-"}`);

describe("planRecovery", () => {
  it("chooses each customer's channel from whether they wrote in and what they agreed to", () => {
    const actions = plan([
      affected("wrote-in", { complained: true }),
      affected("silent"),
      affected("opted-out", { consent: { proactive: false, voice: false } }),
      affected("priority", { tier: "priority", severity: "high", consent: { proactive: true, voice: true } }),
    ]);
    expect(kinds(actions, "wrote-in")).toEqual(["ticket_reply:L2", "credit:200:L2"]);
    expect(kinds(actions, "silent")).toEqual(["proactive_message:L2", "credit:200:L2"]);
    expect(kinds(actions, "opted-out")).toEqual(["account_note:L1", "credit:200:L2"]);
    expect(kinds(actions, "priority")).toEqual(["proactive_message:L2", "voice:L2", "credit:1000:L3"]);
    expect(actions.find((a) => a.customerRef === "priority" && a.kind === "credit")?.reason).toBe(
      "Priority customer whose payment failed: ₹1,000 goodwill credit, above the ₹500 the agents may give one customer, so a human decides",
    );
  });

  it("puts each customer's outreach on their track, and calls by track: complained when it matters, not complained whenever they agreed", () => {
    const voice = { proactive: true, voice: true };
    const actions = plan([
      affected("wrote-in-small", { complained: true, consent: voice }),
      affected("wrote-in-large", { complained: true, consent: voice, severity: "high", amountInr: 12_999 }),
      affected("wrote-in-priority", { complained: true, consent: voice, tier: "priority", severity: "high" }),
      affected("silent-agreed", { consent: voice }),
      affected("silent-opted-out", { consent: { proactive: false, voice: false } }),
      affected("walk-in", { complained: true, confidence: "unverified", severity: undefined, amountInr: 0 }),
    ]);
    expect(kinds(actions, "wrote-in-small")).toEqual(["ticket_reply:L2", "credit:200:L2"]);
    expect(kinds(actions, "wrote-in-large")).toEqual(["ticket_reply:L2", "voice:L2", "credit:1000:L3"]);
    expect(actions.find((a) => a.customerRef === "wrote-in-large" && a.kind === "voice")?.reason).toBe("Wrote in about a ₹12,999 payment and agreed to calls");
    expect(kinds(actions, "wrote-in-priority")).toEqual(["ticket_reply:L2", "voice:L2", "credit:1000:L3"]);
    expect(kinds(actions, "silent-agreed")).toEqual(["proactive_message:L2", "voice:L2", "credit:200:L2"]);
    const track = (ref: string) => [...new Set(actions.filter((a) => a.customerRef === ref && a.track).map((a) => a.track))];
    expect(track("wrote-in-large")).toEqual(["complained"]);
    expect(track("silent-agreed")).toEqual(["not_complained"]);
    expect(track("silent-opted-out")).toEqual(["not_complained"]);
    expect(track("walk-in")).toEqual(["unverified"]);
    expect(actions.filter((a) => a.kind === "credit" || a.kind === "no_credit").every((a) => a.track === undefined)).toBe(true);
  });

  it("gives a customer who paid on a retry the update and a recorded decision not to credit", () => {
    const actions = plan([affected("nisha", { paidOnRetry: true, severity: "low", lastFailedAt: T0 })]);
    expect(kinds(actions, "nisha")).toEqual(["proactive_message:L2", "no_credit:L-"]);
    expect(actions.find((a) => a.kind === "no_credit")).toMatchObject({ status: "done", reason: "Paid on a retry after the failure at 14:12:00, so the update is enough" });
  });

  it("acknowledges an unverified complaint and plans no credit and no proactive contact", () => {
    expect(kinds(plan([affected("judge", { confidence: "unverified", complained: true, severity: undefined })]), "judge")).toEqual(["acknowledge:L2"]);
    expect(plan([affected("ghost", { confidence: "unverified", severity: undefined })])).toEqual([]);
  });

  it("sends a large failed payment's credit to a human even for a standard customer", () => {
    const actions = plan([affected("big", { severity: "high", amountInr: 12_999 })]);
    expect(actions.find((a) => a.kind === "credit")?.reason).toMatch(/^Lost a ₹12,999 payment \(₹10,000 or more\)/);
    expect(kinds(actions, "big")).toContain("credit:1000:L3");
  });

  it("escalates the first credit that would exceed the incident budget, in customer order", () => {
    const actions = plan(
      ["a", "b", "c", "d"].map((r) => affected(r)),
      [],
      { authorityLimitInr: 600, perCustomerLimitInr: 500 },
    );
    expect(actions.filter((a) => a.kind === "credit").map((a) => `${a.customerRef}:L${a.level}`)).toEqual(["a:L2", "b:L2", "c:L2", "d:L3"]);
    expect(actions.find((a) => a.customerRef === "d" && a.kind === "credit")?.reason).toMatch(/already committed ₹600 of the ₹600/);
  });

  it("adds only what's missing: a silent customer who writes in gets a ticket reply, not a second credit", () => {
    const first = plan([affected("s1")]);
    const done = first.map((a) => ({ ...a, status: "done" as const }));
    const again = plan([affected("s1", { complained: true, ticketIds: ["T-9"] })], done);
    expect(kinds(again, "s1")).toEqual(["ticket_reply:L2"]);
    expect(plan([affected("s1")], done)).toEqual([]);
  });
});

describe("outreach messages", () => {
  const priya = affected("c-priya", { name: "Priya K.", complained: true, amountInr: 12_999, methods: ["card"], lastFailedAt: Date.UTC(2026, 8, 25, 7, 55) });

  it("fills each track's message with the customer's own payment, and names their ticket", () => {
    const text = fillOutreach("Hi {name}, ticket {ticket}: {payment}. {credit}Bye.", priya, { ticket: "#4512" });
    expect(text).toBe("Hi Priya, ticket #4512: your ₹12,999 card payment at 13:25. Bye.");
  });

  it("says a credit is under review only when one waits for a human, and never names an amount", () => {
    const text = fillOutreach("{credit}Sorry.", priya, { creditUnderReview: true });
    expect(text).toBe("We're also reviewing a goodwill credit for you and will confirm it shortly. Sorry.");
    expect(text).not.toMatch(/₹/);
  });

  it("falls back to plain words when a detail is missing", () => {
    expect(fillOutreach("{ticket} {payment}", affected("x", { amountInr: 0, methods: [], lastFailedAt: undefined }))).toBe("your ticket your payment");
  });
});
