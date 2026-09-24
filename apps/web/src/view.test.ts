import { initialState, type AffectedCustomer, type Approval, type ClusterView, type IncidentStatus, type IncidentView, type RecoveryAction } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { currentIncident, customerRows, decisionsFor, expectedOutcome, groupVerdict, incidentTitle, matchesFilter, planSummary, progressSteps, sessionSummary } from "./view";

type Timeline = IncidentView["timeline"];
const at = (status: IncidentStatus, sec: number) => ({ at: sec * 1000, status, note: "" });
const incident = (status: IncidentStatus, timeline: Timeline) => ({ status, timeline });
const states = (steps: ReturnType<typeof progressSteps>) => steps.map((s) => `${s.key}:${s.state}`);

describe("incidentTitle", () => {
  it("names the incident after the product area that is failing", () => {
    expect(incidentTitle("checkout_payments")).toBe("Checkout and payment failures");
    expect(incidentTitle("login_account")).toBe("Login and account failures");
    expect(incidentTitle("other")).toBe("Customer-reported failures");
  });
});

describe("progressSteps", () => {
  it("marks the steps already passed as done and the current status as current", () => {
    const steps = progressSteps(
      incident("awaiting_approval", [at("detected", 1), at("investigating", 2), at("root_cause_identified", 3), at("recovering", 4), at("awaiting_approval", 5)]),
    );
    expect(states(steps)).toEqual([
      "detected:done",
      "investigating:done",
      "root_cause_identified:done",
      "recovering:done",
      "awaiting_approval:current",
      "recovered:upcoming",
    ]);
    expect(steps.map((s) => s.at)).toEqual([1000, 2000, 3000, 4000, 5000, undefined]);
  });

  it("leaves out the approval step while no human decision has been asked for", () => {
    const steps = progressSteps(incident("investigating", [at("detected", 1), at("investigating", 2)]));
    expect(states(steps)).toEqual(["detected:done", "investigating:current", "root_cause_identified:upcoming", "recovering:upcoming", "recovered:upcoming"]);
  });

  it("shows every step as done once every affected customer is recovered", () => {
    const withinAuthority = progressSteps(incident("recovered", [at("detected", 1), at("recovered", 9)]));
    expect(withinAuthority.every((s) => s.state === "done")).toBe(true);
    expect(withinAuthority.map((s) => s.key)).not.toContain("awaiting_approval");

    const afterApproval = progressSteps(incident("recovered", [at("detected", 1), at("awaiting_approval", 5), at("recovered", 9)]));
    expect(states(afterApproval)).toContain("awaiting_approval:done");
  });
});

describe("groupVerdict", () => {
  const cluster = (overrides: Partial<ClusterView>): ClusterView => ({
    id: "cl-T-1004",
    memberTicketIds: ["T-1004", "T-1005", "T-1006", "T-1007"],
    reportTicketIds: ["T-1004", "T-1005", "T-1006", "T-1007"],
    cohesion: 0.65,
    cohesionParts: { meaning: 0.3, area: 0.99 },
    failureShare: 1,
    failureCount: 4,
    spanSec: 18,
    burstP: 2.5e-7,
    baselinePerHour: 3,
    dominantSurface: "checkout_payments",
    gates: [
      { name: "size", value: 4, threshold: 4, pass: true, reason: "4 tickets in this group" },
      { name: "cohesion", value: 0.65, threshold: 0.55, pass: true, reason: "they describe the same thing" },
      { name: "failure_share", value: 1, threshold: 0.75, pass: true, reason: "4 of 4 report something broken" },
      { name: "burst", value: 2.5e-7, threshold: 0.001, pass: true, reason: "4 failures in 18 seconds" },
    ],
    fires: true,
    firstAt: 0,
    lastAt: 18_000,
    ...overrides,
  });
  const incidents = { "INC-2026-001": { ticketIds: ["T-1004", "T-1005", "T-1006", "T-1007"] } as IncidentView };

  it("gives the first failing gate's reason when a group is refused", () => {
    const refused = cluster({
      fires: false,
      gates: [
        { name: "size", value: 2, threshold: 4, pass: false, reason: "only 2 tickets in this group (needs 4)" },
        { name: "cohesion", value: 0.12, threshold: 0.55, pass: false, reason: "these complaints are about different things" },
        { name: "failure_share", value: 0.5, threshold: 0.75, pass: false, reason: "1 of 2 report something broken" },
        { name: "burst", value: 1, threshold: 0.001, pass: false, reason: "within normal volume" },
      ],
    });
    expect(groupVerdict(refused, {})).toEqual({ tone: "refused", text: "No incident: only 2 tickets in this group (needs 4)" });
  });

  it("says which incident a group opened", () => {
    expect(groupVerdict(cluster({ incidentId: "INC-2026-001" }), incidents)).toEqual({ tone: "opened", text: "All four gates passed, so INC-2026-001 opened" });
  });

  it("says when a later complaint joined the open incident", () => {
    const grown = cluster({ incidentId: "INC-2026-001", reportTicketIds: ["T-1004", "T-1005", "T-1006", "T-1007", "T-1008"] });
    expect(groupVerdict(grown, incidents)).toEqual({ tone: "joined", text: "The latest complaint joined INC-2026-001, which now has 5 tickets" });
  });
});

describe("currentIncident", () => {
  it("is the most recently opened incident, or none", () => {
    const state = initialState();
    expect(currentIncident(state)).toBeUndefined();
    const a = { id: "INC-2026-001" } as IncidentView;
    const b = { id: "INC-2026-002" } as IncidentView;
    expect(currentIncident({ ...state, incidents: { [a.id]: a, [b.id]: b }, incidentOrder: [a.id, b.id] })).toBe(b);
  });
});

describe("sessionSummary", () => {
  const base = initialState();
  it("describes a running replay, a finished one, a live session and the wait before connecting", () => {
    const replay = { ...base, session: { ...base.session, id: "S2", mode: "replay" as const, speed: 2 } };
    expect(sessionSummary(replay)).toEqual({ label: "Replaying at 2×", tone: "accent" });
    expect(sessionSummary({ ...replay, replayFinished: true })).toEqual({ label: "Replay finished", tone: "neutral" });
    expect(sessionSummary({ ...base, session: { ...base.session, mode: "live" } })).toEqual({ label: "Live session", tone: "success" });
    expect(sessionSummary(base)).toEqual({ label: "Connecting", tone: "neutral" });
  });
});

describe("expectedOutcome", () => {
  it("states what a scenario should do, including which gate refuses it", () => {
    expect(expectedOutcome({ incident: false, refusedBy: "failure_share" })).toBe("Expected: no incident, refused by the failure share gate");
    expect(expectedOutcome({ incident: false })).toBe("Expected: no incident");
    expect(expectedOutcome({ incident: true, rootCause: "deploy:checkout-service@4.21.7", affected: 23, silent: 15, needsHuman: 2 })).toBe(
      "Expected: an incident caused by checkout-service@4.21.7, 23 customers harmed (15 silent), and 2 credits for a human to decide",
    );
    expect(expectedOutcome({ incident: true, rootCause: "provider:razorpay", affected: 10, silent: 4, needsHuman: 1 })).toBe(
      "Expected: an incident caused by razorpay, 10 customers harmed (4 silent), and one credit for a human to decide",
    );
    expect(expectedOutcome({ incident: true, rootCause: "provider:razorpay" })).toBe("Expected: an incident caused by razorpay");
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
    evidence: [{ kind: "payment_failed", label: `UPI payment of ₹999 failed at 14:05:00 (${ref})`, node: `attempt:${ref}:1`, source: "sandbox" }],
    ...over,
  };
}

function act(customerRef: string, kind: RecoveryAction["kind"], status: RecoveryAction["status"], amountInr?: number): RecoveryAction {
  return { id: `${customerRef}-${kind}`, incidentId: "INC-1", customerRef, kind, reason: "", level: 2, status, updatedAt: 0, ...(amountInr ? { amountInr } : {}) };
}

describe("customer rows", () => {
  const inc = {
    id: "INC-1",
    impact: {
      since: 0,
      assessedAt: 0,
      customers: [
        affected("priya", { complained: true, ticketIds: ["T-1"] }),
        affected("ananya", { tier: "priority", severity: "high" }),
        affected("judge", { confidence: "unverified", complained: true, severity: undefined, evidence: [] }),
      ],
    },
    actions: [
      act("priya", "ticket_reply", "done"),
      act("priya", "credit", "done", 200),
      act("ananya", "proactive_message", "done"),
      act("ananya", "voice", "prepared"),
      act("ananya", "credit", "awaiting_approval", 1000),
      act("judge", "acknowledge", "done"),
    ],
  } as unknown as IncidentView;
  const rows = customerRows(inc);

  it("gives each customer their recovery state and strongest evidence", () => {
    expect(rows.map((r) => `${r.customer.ref}:${r.state}`)).toEqual(["priya:recovered", "ananya:needs_human", "judge:unverified"]);
    expect(rows[0]?.headline).toBe("UPI payment of ₹999 failed at 14:05:00 (priya)");
    expect(rows[2]?.headline).toBe("No failed payment on record");
  });

  it("filters by complained, silent, needs a human and not verified", () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) => rows.filter((r) => matchesFilter(r, f)).map((r) => r.customer.ref);
    expect(pick("all")).toEqual(["priya", "ananya", "judge"]);
    expect(pick("complained")).toEqual(["priya"]);
    expect(pick("silent")).toEqual(["ananya"]);
    expect(pick("needs_human")).toEqual(["ananya"]);
    expect(pick("unverified")).toEqual(["judge"]);
  });

  it("sums up a plan in a few words", () => {
    expect(planSummary(rows[1]!.actions)).toBe("Message · Voice · ₹1,000 credit");
    expect(planSummary([act("x", "account_note", "done"), act("x", "no_credit", "done")])).toBe("Account note");
  });
});

describe("decisionsFor", () => {
  it("lists an incident's pending decisions first, oldest first, then decided ones", () => {
    const approval = (id: string, status: Approval["status"], requestedAt: number, decidedAt?: number) =>
      ({ id, incidentId: "INC-1", status, requestedAt, ...(decidedAt ? { decidedAt } : {}) }) as Approval;
    const state = {
      ...initialState(),
      approvals: {
        a: approval("a", "approved", 1, 50),
        b: approval("b", "pending", 3),
        c: approval("c", "pending", 2),
        d: approval("d", "rejected", 1, 60),
        e: { ...approval("e", "pending", 1), incidentId: "INC-2" },
      },
    };
    expect(decisionsFor(state, "INC-1").map((a) => a.id)).toEqual(["c", "b", "d", "a"]);
    expect(decisionsFor(state, undefined)).toEqual([]);
  });
});
