import { initialState, type ClusterView, type IncidentStatus, type IncidentView } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { currentIncident, expectedOutcome, groupVerdict, incidentTitle, progressSteps, sessionSummary } from "./view";

type Timeline = IncidentView["timeline"];
const at = (status: IncidentStatus, sec: number) => ({ at: sec * 1000, status, note: "" });
const incident = (status: IncidentStatus, timeline: Timeline, approvalId?: string) => ({ status, timeline, ...(approvalId ? { approvalId } : {}) });
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
      incident("awaiting_approval", [at("detected", 1), at("investigating", 2), at("root_cause_identified", 3), at("recovering", 4), at("awaiting_approval", 5)], "APR-001"),
    );
    expect(states(steps)).toEqual([
      "detected:done",
      "investigating:done",
      "root_cause_identified:done",
      "recovering:done",
      "awaiting_approval:current",
      "mitigated:upcoming",
    ]);
    expect(steps.map((s) => s.at)).toEqual([1000, 2000, 3000, 4000, 5000, undefined]);
  });

  it("leaves out the approval step while no human decision has been asked for", () => {
    const steps = progressSteps(incident("investigating", [at("detected", 1), at("investigating", 2)]));
    expect(states(steps)).toEqual(["detected:done", "investigating:current", "root_cause_identified:upcoming", "recovering:upcoming", "mitigated:upcoming"]);
  });

  it("shows every step as done once the incident is mitigated", () => {
    const withinAuthority = progressSteps(incident("mitigated", [at("detected", 1), at("mitigated", 9)]));
    expect(withinAuthority.every((s) => s.state === "done")).toBe(true);
    expect(withinAuthority.map((s) => s.key)).not.toContain("awaiting_approval");

    const afterApproval = progressSteps(incident("mitigated", [at("detected", 1), at("awaiting_approval", 5), at("mitigated", 9)], "APR-001"));
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
    expect(
      expectedOutcome({ incident: true, rootCause: "deploy:checkout-service@4.21.7", affected: 23, silent: 15, creditInr: 11500 }),
    ).toBe("Expected: an incident caused by checkout-service@4.21.7, 23 customers affected (15 silent), and a ₹11,500 credit for a human to decide");
    expect(expectedOutcome({ incident: true, rootCause: "provider:razorpay" })).toBe("Expected: an incident caused by razorpay");
  });
});
