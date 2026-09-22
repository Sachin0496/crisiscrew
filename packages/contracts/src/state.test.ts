import { describe, expect, it } from "vitest";
import type { Approval, AuditEntry, IncidentView, Ticket } from "./domain";
import type { CrisisEvent, EventInput } from "./events";
import { initialState, reduce, TOOL_CALL_CAP } from "./state";

let seq = 0;
function ev(input: EventInput): CrisisEvent {
  seq += 1;
  return { ...input, seq, at: 1_000 + seq } as CrisisEvent;
}

const agents = [
  { id: "pattern", name: "Pattern Agent", level: 0 },
  { id: "commander", name: "Incident Commander", level: 1 },
  { id: "investigator", name: "Investigator", level: 0 },
  { id: "recovery", name: "Recovery Agent", level: 2 },
  { id: "handoff", name: "Handoff Agent", level: 3 },
] as const;

function start(): CrisisEvent {
  return ev({
    type: "session.started",
    payload: { sessionId: "s1", mode: "replay", scenarioId: "hero", scenarioTitle: "Hero", speed: 2, agents: [...agents] },
  });
}

function ticket(id: string): Ticket {
  return { id, source: "sandbox", customerRef: `c-${id}`, customerName: `Customer ${id}`, channel: "chat", body: "stuck", receivedAt: 5 };
}

function incident(ticketIds: string[]): IncidentView {
  return {
    id: "INC-1",
    status: "detected",
    severity: "high",
    openedAt: 10,
    surface: "checkout_payments",
    clusterId: "cl-1",
    ticketIds,
    linkedTicketIds: [],
    hypotheses: [],
    updates: [],
    timeline: [{ at: 10, status: "detected", note: "opened" }],
  };
}

describe("reduce", () => {
  it("starts a session with idle agents and forgets the previous session's tickets", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "ticket.received", payload: { ticket: ticket("t1") } }));
    s = reduce(s, start());
    expect(s.ticketOrder).toEqual([]);
    expect(s.session).toMatchObject({ id: "s1", mode: "replay", scenarioId: "hero", speed: 2 });
    expect(s.agents.recovery).toMatchObject({ name: "Recovery Agent", level: 2, status: "idle" });
  });

  it("keeps tickets in arrival order and attaches their signals", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "ticket.received", payload: { ticket: ticket("t2") } }));
    s = reduce(s, ev({ type: "ticket.received", payload: { ticket: ticket("t1") } }));
    s = reduce(
      s,
      ev({
        type: "signal.scored",
        payload: {
          signal: {
            ticketId: "t1",
            surface: "checkout_payments",
            surfaceScore: 0.6,
            failureScore: 0.2,
            isFailure: true,
            entities: { paymentMethods: [], amounts: [], orderIds: [] },
          },
          nearest: [],
        },
      }),
    );
    expect(s.ticketOrder).toEqual(["t2", "t1"]);
    expect(s.tickets.t1?.signal?.isFailure).toBe(true);
    expect(s.tickets.t2?.signal).toBeUndefined();
  });

  it("marks an incident's tickets and records status changes on its timeline", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "ticket.received", payload: { ticket: ticket("t1") } }));
    s = reduce(s, ev({ type: "incident.opened", payload: { incident: incident(["t1"]) } }));
    s = reduce(s, ev({ type: "incident.status_changed", payload: { incidentId: "INC-1", from: "detected", to: "investigating", note: "agents started" } }));
    expect(s.tickets.t1?.incidentId).toBe("INC-1");
    expect(s.incidents["INC-1"]?.status).toBe("investigating");
    expect(s.incidents["INC-1"]?.timeline.map((t) => t.status)).toEqual(["detected", "investigating"]);
  });

  it("links a later ticket once, even if the link event repeats", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "ticket.received", payload: { ticket: ticket("t9") } }));
    s = reduce(s, ev({ type: "incident.opened", payload: { incident: incident([]) } }));
    s = reduce(s, ev({ type: "ticket.linked", payload: { incidentId: "INC-1", ticketId: "t9" } }));
    s = reduce(s, ev({ type: "ticket.linked", payload: { incidentId: "INC-1", ticketId: "t9" } }));
    expect(s.incidents["INC-1"]?.linkedTicketIds).toEqual(["t9"]);
    expect(s.tickets.t9?.incidentId).toBe("INC-1");
  });

  it("keeps only the most recent tool calls and updates the calling agent", () => {
    let s = reduce(initialState(), start());
    for (let i = 0; i < TOOL_CALL_CAP + 5; i++) {
      const entry: AuditEntry = {
        seq: i,
        at: i,
        identity: "investigator",
        tool: `tool_${i}`,
        level: 0,
        argsSummary: "{}",
        decision: "allowed",
        outcome: "ok",
        adapter: "sandbox",
        durationMs: 1,
        prevHash: "",
        hash: `h${i}`,
      };
      s = reduce(s, ev({ type: "tool.called", payload: { entry } }));
    }
    expect(s.toolCalls).toHaveLength(TOOL_CALL_CAP);
    expect(s.toolCalls[0]?.tool).toBe("tool_5");
    expect(s.agents.investigator.lastTool).toBe(`tool_${TOOL_CALL_CAP + 4}`);
  });

  it("follows a credit from proposal through a rejected approval", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "incident.opened", payload: { incident: incident([]) } }));
    s = reduce(
      s,
      ev({ type: "credit.proposed", payload: { incidentId: "INC-1", amountInr: 11_500, perCustomerInr: 500, customers: 23, withinAuthority: false } }),
    );
    const approval: Approval = {
      id: "APR-1",
      incidentId: "INC-1",
      action: "issue_recovery_credit",
      amountInr: 11_500,
      limitInr: 5_000,
      perCustomerInr: 500,
      customers: 23,
      rationale: "over limit",
      caseSummary: "case",
      status: "pending",
      requestedAt: 20,
    };
    s = reduce(s, ev({ type: "approval.requested", payload: { approval } }));
    expect(s.incidents["INC-1"]?.credit?.status).toBe("awaiting_approval");
    expect(s.incidents["INC-1"]?.approvalId).toBe("APR-1");

    s = reduce(s, ev({ type: "approval.decided", payload: { approval: { ...approval, status: "rejected", decidedBy: "approver" } } }));
    expect(s.approvals["APR-1"]?.status).toBe("rejected");
    expect(s.incidents["INC-1"]?.credit?.status).toBe("withheld");
  });

  it("records an issued credit with the amount actually issued", () => {
    let s = reduce(initialState(), start());
    s = reduce(s, ev({ type: "incident.opened", payload: { incident: incident([]) } }));
    s = reduce(
      s,
      ev({ type: "credit.proposed", payload: { incidentId: "INC-1", amountInr: 11_500, perCustomerInr: 500, customers: 23, withinAuthority: false } }),
    );
    s = reduce(
      s,
      ev({ type: "credit.issued", payload: { incidentId: "INC-1", amountInr: 5_000, approvalId: "APR-1", adapter: "sandbox", creditId: "CR-1" } }),
    );
    expect(s.incidents["INC-1"]?.credit).toMatchObject({ status: "issued", amountInr: 5_000 });
    expect(s.credits).toHaveLength(1);
  });

  it("tracks the sequence number of the last event applied", () => {
    const first = start();
    const s = reduce(initialState(), first);
    expect(s.seq).toBe(first.seq);
  });
});
