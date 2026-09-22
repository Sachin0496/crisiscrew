import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import { CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const policy = loadPolicy();
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);

async function replay(id: string) {
  const scenario = scenarios.get(id)!;
  const clock = new ManualClock(T0);
  const ports = createSandboxPorts(scenario, { t0: T0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports,
    embedder,
    clock,
    policy,
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: id, scenarioTitle: scenario.title, speed: 1 },
  });
  await engine.init();
  for (const t of scenarioTickets(scenario, T0)) {
    clock.set(t.receivedAt);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.receivedAt });
    await engine.whenIdle();
  }
  await engine.whenIdle();
  const state = engine.snapshot();
  const incident = state.incidentOrder.map((i) => state.incidents[i]!)[0];
  return { engine, ports, state, incident, clock };
}

describe("hero scenario: checkout release v4.21.7", () => {
  it("names the release as the root cause with high confidence", async () => {
    const { state, incident } = await replay("checkout-v4.21.7");
    expect(state.incidentOrder).toHaveLength(1);
    expect(incident?.rootCause?.hypothesisId).toBe("deploy:checkout-service@4.21.7");
    expect(incident?.rootCause?.confidence).toBeGreaterThan(0.95);
    expect(incident?.severity).toBe("high");
  });

  it("links 8 tickets and finds 23 affected customers, 15 of them silent", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    expect(incident?.linkedTicketIds).toHaveLength(8);
    expect(incident?.affected).toMatchObject({ total: 23 });
    expect(incident?.affected?.ticketed).toHaveLength(8);
    expect(incident?.affected?.silent).toHaveLength(15);
  });

  it("updates customers only through channels they're entitled to, with two voice updates", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    const updates = incident?.updates ?? [];
    const by = (channel: string) => updates.filter((u) => u.channel === channel && u.status !== "refused").map((u) => u.customerRef);
    // Voice is off in sandbox mode, so the two scripts are prepared, not sent.
    expect(by("voice").sort()).toEqual(["s03", "s09"]);
    expect(updates.filter((u) => u.channel === "voice").every((u) => u.status === "prepared" && u.audioId === null)).toBe(true);
    expect(by("ticket_reply")).toHaveLength(8);
    // Pooja Nair, Manoj Kumar and Lakshmi Subramanian did not consent to proactive messages.
    for (const noConsent of ["s05", "s11", "s14"]) expect(by("proactive_message")).not.toContain(noConsent);
  });

  it("asks a human to approve ₹11,500 because it exceeds the ₹5,000 authority", async () => {
    const { state, incident } = await replay("checkout-v4.21.7");
    expect(incident?.status).toBe("awaiting_approval");
    const approval = state.approvals[incident!.approvalId!];
    expect(approval).toMatchObject({ status: "pending", amountInr: 11_500, limitInr: 5_000, perCustomerInr: 500, customers: 23 });
    expect(approval?.caseSummary).toContain("checkout-service v4.21.7");
    expect(state.credits).toHaveLength(0);
  });

  it("refuses contact a customer hasn't agreed to, even when an agent asks for it", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const send = (customerRef: string, channel: string) =>
      engine.gate.call("recovery", "send_customer_update", { incidentId: incident!.id, customerRef, channel, text: "test" });
    // Pooja Nair (s05) declined proactive messages; Aditya Menon (s01) never agreed to voice; neither filed a ticket.
    expect(await send("s05", "proactive_message")).toMatchObject({ ok: false, reason: "customer has not agreed to proactive messages" });
    expect(await send("s01", "voice")).toMatchObject({ ok: false, reason: "customer has not agreed to voice contact" });
    expect(await send("s01", "ticket_reply")).toMatchObject({ ok: false, reason: "this customer has no ticket in the incident" });
    expect(engine.audit.entries().slice(-3).every((e) => e.decision === "denied")).toBe(true);
  });

  it("keeps the Pattern Agent read-only and the audit chain intact", async () => {
    const { engine } = await replay("checkout-v4.21.7");
    const entries = engine.audit.entries();
    expect(entries.filter((e) => e.identity === "pattern" && (e.level ?? 0) > 0)).toEqual([]);
    expect(entries.filter((e) => e.decision === "denied")).toEqual([]);
    expect(engine.audit.verify().ok).toBe(true);
  });
});

describe("approval decisions", () => {
  it("approve: the Handoff Agent issues the full ₹11,500", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    await engine.decide(incident!.approvalId!, { decision: "approve" }, "test-approver");
    await engine.whenIdle();
    const s = engine.snapshot();
    expect(s.credits).toEqual([expect.objectContaining({ amountInr: 11_500, approvalId: incident!.approvalId })]);
    expect(s.incidents[incident!.id]?.status).toBe("mitigated");
    expect(engine.audit.entries().at(-1)).toMatchObject({ identity: "handoff", tool: "issue_recovery_credit", level: 3, decision: "allowed" });
  });

  it("modify: only the approved ₹5,000 can be issued; the original ₹11,500 is refused", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    await engine.decide(incident!.approvalId!, { decision: "modify", amountInr: 5_000 }, "test-approver");
    await engine.whenIdle();
    expect(engine.snapshot().credits.map((c) => c.amountInr)).toEqual([5_000]);
    const retry = await engine.gate.call("handoff", "issue_recovery_credit", {
      incidentId: incident!.id,
      amountInr: 11_500,
      approvalId: incident!.approvalId,
    });
    expect(retry.ok).toBe(false);
  });

  it("reject: nothing is issued and the credit is withheld", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    await engine.decide(incident!.approvalId!, { decision: "reject", note: "offer a coupon instead" }, "test-approver");
    await engine.whenIdle();
    const s = engine.snapshot();
    expect(s.credits).toHaveLength(0);
    expect(s.incidents[incident!.id]?.credit?.status).toBe("withheld");
    expect(s.incidents[incident!.id]?.status).toBe("mitigated");
  });

  it("refuses a second decision on the same approval", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    await engine.decide(incident!.approvalId!, { decision: "approve" }, "a");
    await expect(engine.decide(incident!.approvalId!, { decision: "reject" }, "b")).rejects.toThrow(/already/);
  });
});

describe("UPI provider outage", () => {
  it("blames the provider and credits ₹5,000 within authority without asking a human", async () => {
    const { state, incident } = await replay("upi-provider-outage");
    expect(incident?.rootCause?.hypothesisId).toBe("provider:razorpay");
    expect(incident?.affected?.total).toBe(10);
    expect(state.credits).toEqual([expect.objectContaining({ amountInr: 5_000 })]);
    expect(Object.keys(state.approvals)).toHaveLength(0);
    expect(incident?.status).toBe("mitigated");
  });
});

describe("restraint", () => {
  it.each(["lookalike-checkout-questions", "scattered-failures", "two-card-complaints", "quiet-day"])("%s opens no incident and runs no agent", async (id) => {
    const { state, engine } = await replay(id);
    expect(state.incidentOrder).toHaveLength(0);
    expect(engine.audit.entries()).toHaveLength(0);
  });
});
