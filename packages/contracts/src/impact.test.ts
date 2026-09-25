import { describe, expect, it } from "vitest";
import type { AffectedCustomer, IncidentView, RecoveryAction, RecoveryStatus } from "./domain";
import { customerState, impactGraph, recoveryCoverage, recoveryMetrics } from "./impact";
import { initialState } from "./state";

function customer(ref: string, over: Partial<AffectedCustomer> = {}): AffectedCustomer {
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
    methods: ["card"],
    paidOnRetry: false,
    evidence: [],
    ...over,
  };
}

let n = 0;
function action(customerRef: string, status: RecoveryStatus, over: Partial<RecoveryAction> = {}): RecoveryAction {
  n += 1;
  return { id: `RA-${n}`, incidentId: "INC-1", customerRef, kind: "proactive_message", reason: "", level: 2, status, updatedAt: 0, ...over };
}

function incident(customers: AffectedCustomer[], actions: RecoveryAction[], over: Partial<IncidentView> = {}): IncidentView {
  return {
    id: "INC-1",
    status: "recovering",
    severity: "high",
    openedAt: 63_000,
    surface: "checkout_payments",
    clusterId: "cl",
    ticketIds: [],
    linkedTicketIds: [],
    hypotheses: [],
    impact: { since: 0, assessedAt: 0, customers },
    actions,
    updates: [],
    timeline: [],
    ...over,
  };
}

describe("customerState", () => {
  it("is recovered once every action is done, prepared or decided by a human", () => {
    expect(customerState(customer("a"), [action("a", "done"), action("a", "prepared", { kind: "voice" }), action("a", "declined", { kind: "credit" })])).toBe("recovered");
  });

  it("needs a human while an approval is pending, and attention when an action failed", () => {
    expect(customerState(customer("a"), [action("a", "done"), action("a", "awaiting_approval", { kind: "credit" })])).toBe("needs_human");
    expect(customerState(customer("a"), [action("a", "failed"), action("a", "awaiting_approval")])).toBe("attention");
  });

  it("is in progress with nothing planned yet or actions still to run", () => {
    expect(customerState(customer("a"), [])).toBe("in_progress");
    expect(customerState(customer("a"), [action("a", "done"), action("a", "planned", { kind: "credit" })])).toBe("in_progress");
  });

  it("never counts an unverified complaint as recovered, whatever was done", () => {
    expect(customerState(customer("x", { confidence: "unverified" }), [action("x", "done", { kind: "ticket_reply" })])).toBe("unverified");
  });
});

describe("recoveryCoverage", () => {
  it("counts only confirmed customers, split into complained and silent", () => {
    const customers = [
      customer("a", { complained: true }),
      customer("b"),
      customer("c"),
      customer("x", { confidence: "unverified", complained: true }),
    ];
    const coverage = recoveryCoverage(
      incident(customers, [action("a", "done"), action("b", "done"), action("c", "awaiting_approval"), action("x", "done")]),
    );
    expect(coverage).toEqual({
      confirmed: 3,
      complained: 1,
      silent: 2,
      unverified: 1,
      recovered: 2,
      needsHuman: 1,
      inProgress: 0,
      attention: 0,
      ratio: 2 / 3,
      complete: false,
    });
  });

  it("is complete only when every confirmed customer is recovered", () => {
    expect(recoveryCoverage(incident([customer("a")], [action("a", "done")])).complete).toBe(true);
    expect(recoveryCoverage(incident([], [])).complete).toBe(false);
    expect(recoveryCoverage(incident([], [])).ratio).toBeNull();
  });
});

describe("recoveryMetrics", () => {
  it("measures detection time, duplicates, proactive contacts and spend", () => {
    const state = initialState();
    const tickets = Object.fromEntries(
      ["T-1", "T-2", "T-3"].map((id, i) => [
        id,
        { ticket: { id, source: "sandbox" as const, customerRef: id, customerName: id, channel: "chat" as const, body: "x", receivedAt: 45_000 + i * 7_000 } },
      ]),
    );
    const inc = incident([customer("a"), customer("b")], [action("a", "done")], {
      ticketIds: ["T-1", "T-2"],
      linkedTicketIds: ["T-1", "T-2", "T-3"],
      updates: [
        { id: "U1", incidentId: "INC-1", customerRef: "a", customerName: "a", channel: "proactive_message", text: "", source: "template", status: "sent", adapter: "sandbox" },
        { id: "U2", incidentId: "INC-1", customerRef: "b", customerName: "b", channel: "voice", text: "", source: "template", status: "prepared", adapter: "off" },
        { id: "U3", incidentId: "INC-1", customerRef: "c", customerName: "c", channel: "ticket_reply", text: "", source: "template", status: "sent", adapter: "sandbox" },
      ],
    });
    const metrics = recoveryMetrics(
      {
        ...state,
        tickets,
        credits: [
          { id: "CR-1", incidentId: "INC-1", customerRef: "a", amountInr: 200, adapter: "sandbox", at: 1 },
          { id: "CR-2", incidentId: "INC-1", customerRef: "b", amountInr: 500, approvalId: "APR-1", adapter: "sandbox", at: 2 },
          { id: "CR-3", incidentId: "INC-9", customerRef: "z", amountInr: 900, adapter: "sandbox", at: 3 },
        ],
        approvals: {
          "APR-2": {
            id: "APR-2",
            incidentId: "INC-1",
            action: "issue_recovery_credit",
            actionId: "RA-9",
            customerRef: "c",
            customerName: "c",
            amountInr: 1_000,
            limitInr: 500,
            rationale: "",
            caseSummary: "",
            status: "pending",
            requestedAt: 0,
          },
        },
      },
      inc,
    );
    expect(metrics).toEqual({
      complaintToIncidentSec: 18,
      silentFound: 2,
      duplicateTicketsAvoided: 2,
      proactiveContacts: 1,
      unrecovered: 1,
      spend: { issuedInr: 200, approvedInr: 500, awaitingInr: 1_000 },
    });
  });
});

describe("impactGraph", () => {
  it("joins customers to the incident through their evidence and recovery actions, skipping absences", () => {
    const priya = customer("c-priya", {
      name: "Priya K.",
      complained: true,
      evidence: [
        { kind: "payment_failed", label: "Card payment of ₹649 failed at 14:12:40", node: "attempt:c-priya:40000", at: 40_000, source: "sandbox" },
        { kind: "service", label: "Affected service: checkout-service", node: "service:checkout-service", source: "sandbox" },
        { kind: "reported", label: "Opened T-1004", node: "ticket:T-1004", at: 45_000, source: "sandbox" },
      ],
    });
    const arun = customer("s01", {
      evidence: [
        { kind: "service", label: "Affected service: checkout-service", node: "service:checkout-service", source: "sandbox" },
        { kind: "no_ticket", label: "Never contacted support", node: "none", source: "engine" },
      ],
    });
    const graph = impactGraph(
      incident([priya, arun], [action("s01", "done", { id: "RA-100" })], {
        rootCause: { hypothesisId: "deploy:checkout-service@4.21.7", label: "checkout-service v4.21.7", confidence: 0.97 },
      }),
    );
    expect(graph.nodes.filter((node) => node.kind === "service")).toEqual([{ id: "service:checkout-service", kind: "service", label: "checkout-service" }]);
    expect(graph.edges).toContainEqual({ from: "incident:INC-1", to: "cause:deploy:checkout-service@4.21.7", kind: "caused_by", label: "97% confidence" });
    expect(graph.edges).toContainEqual({ from: "customer:c-priya", to: "ticket:T-1004", kind: "reported", label: "Opened T-1004" });
    expect(graph.edges).toContainEqual({ from: "customer:s01", to: "action:RA-100", kind: "recovery", label: "proactive_message: done" });
    expect(graph.edges.some((e) => e.kind === "no_ticket")).toBe(false);
  });
});
