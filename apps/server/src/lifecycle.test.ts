import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import { CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { actionsFor, customerState, recoveryCoverage, recoveryMetrics, type Scenario } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const policy = loadPolicy();
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);

async function replay(id: string) {
  return run(scenarios.get(id)!);
}

async function run(scenario: Scenario) {
  const id = scenario.id;
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

const approvalFor = (engine: CrisisEngine, incidentId: string, customerRef: string) =>
  Object.values(engine.snapshot().approvals).find((a) => a.incidentId === incidentId && a.customerRef === customerRef)!;

describe("hero scenario: checkout release v4.21.7", () => {
  it("names the release as the root cause with high confidence", async () => {
    const { state, incident } = await replay("checkout-v4.21.7");
    expect(state.incidentOrder).toHaveLength(1);
    expect(incident?.rootCause?.hypothesisId).toBe("deploy:checkout-service@4.21.7");
    expect(incident?.rootCause?.confidence).toBeGreaterThan(0.95);
    expect(incident?.severity).toBe("high");
  });

  it("proves 23 customers were harmed: 8 complained and 15 stayed silent, each with evidence", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    expect(incident?.linkedTicketIds).toHaveLength(8);
    const coverage = recoveryCoverage(incident!);
    expect(coverage).toMatchObject({ confirmed: 23, complained: 8, silent: 15, unverified: 0 });
    const customers = incident!.impact!.customers;
    expect(customers.every((c) => c.evidence.some((e) => e.kind === "payment_failed" || e.kind === "payment_pending"))).toBe(true);
    expect(customers.every((c) => c.evidence.some((e) => e.kind === "cause" && e.label === "Likely cause: checkout-service v4.21.7 (97%)"))).toBe(true);
    // The window opens at the release, not 30 minutes before the first complaint.
    expect(incident!.impact!.since).toBe(T0 - 795_000);
    const arun = customers.find((c) => c.ref === "s01")!;
    expect(arun).toMatchObject({ complained: false, confidence: "confirmed", severity: "medium", methods: ["upi"] });
    expect(arun.evidence.map((e) => e.kind)).toEqual(["payment_failed", "service", "cause", "window", "no_ticket"]);
  });

  it("plans each customer's recovery from their own impact", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    const plan = (ref: string) => actionsFor(incident!, ref).map((a) => `${a.kind}:${a.status}`);
    expect(plan("c-priya")).toEqual(["ticket_reply:done", "credit:done"]);
    // Pooja opted out of proactive messages: nobody messages her, her account gets a note and a credit.
    expect(plan("s05")).toEqual(["account_note:done", "credit:done"]);
    // Nisha's payment went through on a retry: the update, and a recorded decision not to credit.
    expect(plan("s07")).toEqual(["proactive_message:done", "no_credit:done"]);
    // Ananya is a priority customer: a voice update (prepared, voice is off) and a ₹1,000 credit for a human to decide.
    expect(plan("s03")).toEqual(["proactive_message:done", "voice:prepared", "credit:awaiting_approval"]);
    // Ritika was silent when the plan was made; her later ticket adds a reply to it.
    expect(plan("c-ritika")).toEqual(["proactive_message:done", "credit:done", "ticket_reply:done"]);
  });

  it("settles 21 of 23 within policy and sends two priority customers' credits to a human", async () => {
    const { state, incident } = await replay("checkout-v4.21.7");
    expect(incident?.status).toBe("awaiting_approval");
    expect(recoveryCoverage(incident!)).toMatchObject({ recovered: 21, needsHuman: 2, inProgress: 0, attention: 0, complete: false });
    const pending = Object.values(state.approvals).filter((a) => a.status === "pending");
    expect(pending.map((a) => `${a.customerName}:${a.amountInr}`).sort()).toEqual(["Ananya Iyer:1000", "Farhan Qureshi:1000"]);
    expect(pending[0]).toMatchObject({ limitInr: 500 });
    expect(pending.find((a) => a.customerRef === "s03")?.caseSummary).toContain("Card payment of ₹12,999 failed at");
    expect(state.credits).toHaveLength(20);
    expect(state.credits.every((c) => c.amountInr === 200 && !c.approvalId)).toBe(true);
    expect(recoveryMetrics(state, incident!)).toMatchObject({
      complaintToIncidentSec: 18,
      silentFound: 15,
      duplicateTicketsAvoided: 7,
      unrecovered: 2,
      spend: { issuedInr: 4_000, approvedInr: 0, awaitingInr: 2_000 },
    });
  });

  it("contacts customers only through channels they agreed to", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    const updates = incident?.updates ?? [];
    const by = (channel: string) => updates.filter((u) => u.channel === channel).map((u) => u.customerRef);
    expect(by("voice").sort()).toEqual(["s03", "s09"]);
    expect(updates.filter((u) => u.channel === "voice").every((u) => u.status === "prepared" && u.audioId === null)).toBe(true);
    expect(by("ticket_reply")).toHaveLength(8);
    for (const noConsent of ["s05", "s11", "s14"]) expect(by("proactive_message")).not.toContain(noConsent);
  });

  it("writes the outcome back to every complaint's ticket and keeps the engineering incident up to date", async () => {
    const { ports, incident } = await replay("checkout-v4.21.7");
    const outcomes = ports.record.notes.filter((n) => n.text.startsWith("CrisisCrew · "));
    expect(outcomes).toHaveLength(8);
    expect(outcomes[0]?.text).toMatch(/Confirmed affected: .*failed at/);
    expect(incident?.engineering).toEqual({ id: "ENG-001", adapter: "sandbox", importance: "P1", change: { id: "CHG-001" } });
    // Filed after the investigation, so the findings are in the ticket itself; notes follow as recovery moves.
    expect(ports.record.incidents[0]?.description).toContain("Likely cause: checkout-service v4.21.7 (97% confidence)");
    expect(ports.record.incidents[0]?.notes.map((n) => n.split(/[:.]/)[0])).toEqual(["Customer impact"]);
  });

  it("opens at P2 for a tier-1 area, then raises it to P1 and pages on-call once 23 customers are proved affected", async () => {
    const { engine, ports, incident } = await replay("checkout-v4.21.7");
    expect(incident?.importance).toMatchObject({ level: "P1", page: true, source: "rules", stage: "root_cause" });
    expect(incident?.importance?.reasons.map((r) => r.text)).toEqual([
      "23 customers affected (20 or more is P1)",
      "₹63,987 in failed or pending payments (₹25,000 or more is P2)",
      "2 priority customers affected (1 or more is P2)",
      "Checkout & payments is a tier-1 area",
      "checkout-service v4.21.7 is the likely cause (97%), so a rollback is an option",
    ]);
    expect(incident?.severity).toBe("high");
    // The record is filed after the importance is known, so it starts at P1 and needs no raise.
    expect(ports.record.incidents[0]?.importance).toBe("P1");
    const raised = engine.audit.entries().filter((e) => e.tool === "update_engineering_incident" && e.argsSummary.includes(`"importance":"P1"`));
    expect(raised).toHaveLength(0);
  });

  it("lets a human lower the importance, and the rules then leave it alone", async () => {
    const { engine, ports, incident, clock } = await replay("checkout-v4.21.7");
    const id = incident!.id;
    const set = await engine.setImportance(id, "P3", "Asha", "rollback done, customers covered");
    expect(set).toMatchObject({ level: "P3", page: false, source: "human", by: "Asha" });
    expect(ports.record.incidents[0]?.importance).toBe("P3");
    expect(ports.record.incidents[0]?.notes.at(-1)).toMatch(/^Importance P3\. Set by Asha: “rollback done, customers covered”/);
    // A later complaint joins the incident, and the rules would say P1 again.
    clock.advance(30_000);
    const again = scenarios.get("checkout-v4.21.7")!.tickets.find((t) => t.customerRef === "c-arjun")!;
    await engine.ingest({ customerRef: "s02", customerName: "Kavya Reddy", channel: "chat", body: again.body, receivedAt: clock.now() });
    await engine.whenIdle();
    expect(engine.snapshot().incidents[id]?.linkedTicketIds).toHaveLength(9);
    expect(engine.snapshot().incidents[id]?.importance).toMatchObject({ level: "P3", source: "human" });
    await expect(engine.setImportance("INC-404", "P1", "Asha")).rejects.toThrow(/no incident INC-404/);
  });

  it("refuses contact and money that the evidence and consent don't support", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const id = incident!.id;
    const send = (customerRef: string, channel: string) => engine.gate.call("handoff", "send_customer_update", { incidentId: id, customerRef, channel, text: "test" });
    expect(await send("s05", "proactive_message")).toMatchObject({ ok: false, reason: "customer has not agreed to proactive messages" });
    expect(await send("s01", "voice")).toMatchObject({ ok: false, reason: "customer has not agreed to voice contact" });
    expect(await send("s01", "ticket_reply")).toMatchObject({ ok: false, reason: "this customer has no ticket in the incident" });
    // b1 asked a question and has no failed payment: not affected, so never contacted proactively.
    expect(await send("b1", "proactive_message")).toMatchObject({ ok: false, reason: "no evidence this customer was affected, so they aren't contacted" });
    const credit = (customerRef: string, amountInr: number) => engine.gate.call("recovery", "issue_recovery_credit", { incidentId: id, customerRef, amountInr });
    expect(await credit("b1", 200)).toMatchObject({ ok: false, reason: "no evidence this customer was harmed, so no credit" });
    expect(await credit("s01", 200)).toMatchObject({ ok: false, reason: "a credit was already issued to this customer" });
    expect(await credit("s07", 200)).toMatchObject({ ok: false, reason: "no credit is planned for this customer" });
    expect(await credit("s03", 1_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/needs L3; Recovery Agent is limited to L2/) });
    expect(engine.audit.entries().slice(-8).every((e) => e.decision === "denied")).toBe(true);
  });

  it("gives every customer message to the Handoff Agent, and refuses one from the Recovery Agent", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const sends = engine.audit.entries().filter((e) => e.tool === "send_customer_update" && e.decision === "allowed");
    expect(sends.length).toBeGreaterThan(0);
    expect(new Set(sends.map((e) => e.identity))).toEqual(new Set(["handoff"]));
    expect(await engine.gate.call("recovery", "send_customer_update", { incidentId: incident!.id, customerRef: "s01", channel: "proactive_message", text: "test" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not on Recovery Agent's allow-list|not allowed|allow-list/),
    });
  });

  it("sends each track its own message: an answer to the complaint, or news of a failure the customer may not have noticed", async () => {
    const { incident } = await replay("checkout-v4.21.7");
    const update = (ref: string, channel: string) => incident!.updates.find((u) => u.customerRef === ref && u.channel === channel)?.text ?? "";
    // Priya wrote in: her reply names her ticket and her payment.
    expect(update("c-priya", "ticket_reply")).toMatch(/^Hi Priya, thanks for writing in \(ticket T-\d+\)\. You're right: some payments at checkout have been failing since about \d\d:\d\d, and your ₹[\d,]+ \w+ payment at \d\d:\d\d was one of them\./);
    // Aditya never wrote in: the message tells him what happened to his payment.
    expect(update("s01", "proactive_message")).toMatch(/^Hi Aditya, you may not have noticed, but your ₹[\d,]+ UPI payment at \d\d:\d\d didn't go through\./);
    // Ananya's ₹1,000 credit waits for a human: she hears now that a credit is under review, with no amount promised.
    const ananya = update("s03", "proactive_message");
    expect(ananya).toContain("We're also reviewing a goodwill credit for you and will confirm it shortly.");
    expect(ananya).not.toContain("₹1,000");
    expect(update("s01", "proactive_message")).not.toContain("goodwill credit");
    expect(update("s03", "voice")).toMatch(/^Hello Ananya, this is customer care\. You may not have noticed, but your ₹12,999 card payment at \d\d:\d\d didn't go through today\./);
    // Every outreach action carries its track.
    const tracks = new Set(incident!.actions.filter((a) => ["ticket_reply", "proactive_message", "voice", "account_note"].includes(a.kind)).map((a) => `${a.kind}:${a.track}`));
    expect(tracks).toEqual(new Set(["ticket_reply:complained", "proactive_message:not_complained", "voice:not_complained", "account_note:not_complained"]));
  });

  it("keeps the Pattern Agent read-only and the audit chain intact", async () => {
    const { engine } = await replay("checkout-v4.21.7");
    const entries = engine.audit.entries();
    expect(entries.filter((e) => e.identity === "pattern" && (e.level ?? 0) > 0)).toEqual([]);
    expect(entries.filter((e) => e.decision === "denied")).toEqual([]);
    expect(engine.audit.verify().ok).toBe(true);
  });
});

describe("human decisions, one customer at a time", () => {
  it("approve and modify: each customer gets exactly the approved amount, and the incident is recovered at 23/23", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const id = incident!.id;
    await engine.decide(approvalFor(engine, id, "s03").id, { decision: "approve" }, "test-approver");
    await engine.whenIdle();
    expect(engine.snapshot().incidents[id]?.status).toBe("awaiting_approval");
    expect(recoveryCoverage(engine.snapshot().incidents[id]!).recovered).toBe(22);

    await engine.decide(approvalFor(engine, id, "s09").id, { decision: "modify", amountInr: 500 }, "test-approver");
    await engine.whenIdle();
    const s = engine.snapshot();
    const approved = s.credits.filter((c) => c.approvalId).map((c) => `${c.customerRef}:${c.amountInr}`);
    expect(approved.sort()).toEqual(["s03:1000", "s09:500"]);
    expect(recoveryCoverage(s.incidents[id]!)).toMatchObject({ recovered: 23, confirmed: 23, complete: true });
    expect(s.incidents[id]?.status).toBe("recovered");
    expect(s.incidents[id]?.timeline.at(-1)?.note).toBe("Every one of the 23 affected customers has a completed recovery");
    expect(recoveryMetrics(s, s.incidents[id]!).spend).toEqual({ issuedInr: 4_000, approvedInr: 1_500, awaitingInr: 0 });
  });

  it("modify: the original amount is refused, and an approval can't pay another customer", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const id = incident!.id;
    const farhan = approvalFor(engine, id, "s09");
    await engine.decide(farhan.id, { decision: "modify", amountInr: 500 }, "test-approver");
    await engine.whenIdle();
    const retry = await engine.gate.call("handoff", "issue_recovery_credit", { incidentId: id, customerRef: "s09", amountInr: 1_000, approvalId: farhan.id });
    expect(retry).toMatchObject({ ok: false });
    const elsewhere = await engine.gate.call("handoff", "issue_recovery_credit", { incidentId: id, customerRef: "s03", amountInr: 500, approvalId: farhan.id });
    expect(elsewhere).toMatchObject({ ok: false, reason: `no approval ${farhan.id} for this customer` });
  });

  it("reject: nothing is paid, the decision is recorded, and the customer still counts as handled", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const id = incident!.id;
    const ananya = approvalFor(engine, id, "s03");
    await engine.decide(ananya.id, { decision: "reject", note: "offer a coupon instead" }, "test-approver");
    await engine.whenIdle();
    const s = engine.snapshot();
    expect(s.credits.some((c) => c.customerRef === "s03")).toBe(false);
    const credit = s.incidents[id]!.actions.find((a) => a.customerRef === "s03" && a.kind === "credit");
    expect(credit).toMatchObject({ status: "declined", detail: "Declined by test-approver: “offer a coupon instead”" });
    expect(customerState(s.incidents[id]!.impact!.customers.find((c) => c.ref === "s03")!, actionsFor(s.incidents[id]!, "s03"))).toBe("recovered");
  });

  it("refuses a second decision on the same approval", async () => {
    const { engine, incident } = await replay("checkout-v4.21.7");
    const ananya = approvalFor(engine, incident!.id, "s03");
    await engine.decide(ananya.id, { decision: "approve" }, "a");
    await expect(engine.decide(ananya.id, { decision: "reject" }, "b")).rejects.toThrow(/already/);
  });
});

describe("UPI provider outage", () => {
  it("blames the provider and sends only the priority customer's credit to a human", async () => {
    const { state, incident } = await replay("upi-provider-outage");
    expect(incident?.rootCause?.hypothesisId).toBe("provider:razorpay");
    expect(recoveryCoverage(incident!)).toMatchObject({ confirmed: 10, complained: 6, silent: 4, recovered: 9, needsHuman: 1 });
    expect(Object.values(state.approvals).map((a) => a.customerName)).toEqual(["Indu Nair"]);
    expect(state.credits.reduce((sum, c) => sum + c.amountInr, 0)).toBe(1_800);
    expect(incident?.status).toBe("awaiting_approval");
  });
});

describe("importance, as each scenario expects", () => {
  it.each([...scenarios.values()].filter((s) => s.expected.importance).map((s) => [s.id, s] as const))("%s", async (id) => {
    const scenario = scenarios.get(id)!;
    const { incident } = await replay(id);
    expect(incident?.importance?.level).toBe(scenario.expected.importance);
    expect(incident?.importance?.page).toBe(scenario.expected.pages);
  });
});

describe("restraint", () => {
  it.each(["lookalike-checkout-questions", "scattered-failures", "two-card-complaints", "quiet-day"])("%s opens no incident and runs no agent", async (id) => {
    const { state, engine } = await replay(id);
    expect(state.incidentOrder).toHaveLength(0);
    expect(engine.audit.entries()).toHaveLength(0);
  });
});

describe("a checkout question asked during the burst", () => {
  // b1 asks about paying by UPI 5 seconds before three customers report failures. The question counts toward the gates,
  // but b1 has no failed payment, so b1 must not be treated as affected.
  const hero = scenarios.get("checkout-v4.21.7")!;
  const scenario: Scenario = {
    ...hero,
    id: "question-in-burst",
    tickets: [
      { at: "+40s", customerRef: "b1", channel: "chat", body: "Can I pay by UPI at checkout instead of using a card?" },
      ...hero.tickets.filter((t) => ["c-priya", "c-arjun", "c-sneha"].includes(t.customerRef)),
    ],
  };

  it("opens the incident on the failure reports only: the person who asked gets no outage update and no credit", async () => {
    const { state, incident } = await run(scenario);
    expect(state.incidentOrder).toHaveLength(1);
    expect(state.candidate?.memberTicketIds).toContain("T-1001");
    expect(incident?.ticketIds).toEqual(["T-1002", "T-1003", "T-1004"]);
    expect(incident?.linkedTicketIds).not.toContain("T-1001");
    expect(incident?.impact?.customers.map((c) => c.ref)).not.toContain("b1");
    expect(incident?.updates.filter((u) => u.customerRef === "b1")).toEqual([]);
  });
});

describe("a complaint that can't be matched to a failed payment", () => {
  // A walk-in customer reports the same failure after the incident opened, but has no payment on record.
  const hero = scenarios.get("checkout-v4.21.7")!;
  const scenario: Scenario = {
    ...hero,
    id: "walk-in-complaint",
    world: { ...hero.world, customers: [...hero.world.customers, { ref: "walk-in", name: "Walk-in Customer", tier: "standard", consent: { proactive: true, voice: false } }] },
    tickets: [
      ...hero.tickets.filter((t) => ["c-priya", "c-arjun", "c-sneha", "c-varun"].includes(t.customerRef)),
      { at: "+80s", customerRef: "walk-in", channel: "chat", body: "Every payment method fails when I try to check out." },
    ],
  };

  it("acknowledges them on their ticket, credits nothing, and keeps them out of the coverage ratio", async () => {
    const { state, incident } = await run(scenario);
    const walkIn = incident!.impact!.customers.find((c) => c.ref === "walk-in")!;
    expect(walkIn).toMatchObject({ confidence: "unverified", complained: true });
    expect(actionsFor(incident!, "walk-in").map((a) => `${a.kind}:${a.status}`)).toEqual(["acknowledge:done"]);
    expect(incident!.updates.find((u) => u.customerRef === "walk-in")?.text).toMatch(/couldn't find a failed payment on your account yet/);
    expect(state.credits.some((c) => c.customerRef === "walk-in")).toBe(false);
    expect(recoveryCoverage(incident!)).toMatchObject({ unverified: 1, confirmed: 23 });
  });
});
