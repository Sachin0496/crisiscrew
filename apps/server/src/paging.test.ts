import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import type { Policy, Scenario, ScenarioResponder } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);
const hero = scenarios.get("checkout-v4.21.7")!;

/** The hero scenario with a different on-call roster. */
function heroWith(oncall: Partial<ScenarioResponder>[]): Scenario {
  const roster = oncall.map((r, i) => ({ name: `Responder ${i + 1}`, role: (["primary", "secondary", "tertiary"] as const)[i]!, phone: `+9190000200${i}`, answers: "acknowledges" as const, ...r }));
  return { ...hero, world: { ...hero.world, oncall: roster } };
}

async function run(scenario: Scenario, policy: Policy = loadPolicy()) {
  const clock = new ManualClock(T0);
  const ports = createSandboxPorts(scenario, { t0: T0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports,
    embedder,
    clock,
    policy,
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: scenario.id, scenarioTitle: scenario.title, speed: 1 },
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
  const pages = engine.audit.entries().filter((e) => e.tool === "page_on_call");
  return { engine, ports, state, incident, pages };
}

describe("paging on-call", () => {
  it("pages the hero's primary on-call engineer exactly once, after the incident opens, and records the acknowledgement", async () => {
    const { incident, pages, ports, state } = await run(hero);
    expect(pages.map((p) => p.decision)).toEqual(["allowed"]);
    expect(incident?.paging).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: "Neha Kapoor",
      via: "call",
      attempts: [{ attempt: 1, responder: "Neha Kapoor", role: "primary", phone: "••••0001", state: "acknowledged" }],
    });
    // The call itself: one on-call call, answered, and 1 pressed.
    const calls = Object.values(state.calls).filter((c) => c.purpose === "oncall");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: "completed", digits: "1", metadata: { incidentId: incident!.id, attempt: "1" } });
    expect(ports.record.calls[0]?.script).toBe(
      "This is CrisisCrew with a P1 incident, INC 2026 001. Checkout and payments is failing. 23 customers are affected. The likely cause is checkout-service v4.21.7, at 97 percent confidence.",
    );
    // The page came before the ticket was filed, so its outcome is in the ticket's description.
    expect(ports.record.incidents[0]?.description).toContain("On-call: acknowledged by Neha Kapoor.\n  - On-call page 1: Neha Kapoor (primary), acknowledged by pressing 1.");
    // The page was placed after the incident opened, and after the P1 decision it rests on.
    expect(pages[0]!.at).toBeGreaterThanOrEqual(incident!.openedAt);
    expect(incident!.importance!.assessedAt).toBeLessThanOrEqual(pages[0]!.at);
    expect(hero.expected.acknowledgedBy).toBe("Neha Kapoor");
  });

  it("escalates to the secondary when the primary doesn't answer", async () => {
    const { incident, pages, ports } = await run(heroWith([{ answers: "no_answer" }, { answers: "acknowledges" }]));
    expect(pages.map((p) => p.decision)).toEqual(["allowed", "allowed"]);
    expect(incident?.paging?.attempts.map((a) => `${a.role}:${a.state}`)).toEqual(["primary:no_answer", "secondary:acknowledged"]);
    expect(incident?.paging).toMatchObject({ status: "acknowledged", acknowledgedBy: "Responder 2" });
    const record = ports.record.incidents[0]!;
    const outcomes = [...record.description.split("\n").map((l) => l.trim().replace(/^- /, "")), ...record.notes].filter((n) => n.startsWith("On-call page"));
    expect(outcomes).toEqual(["On-call page 1: Responder 1 (primary), no answer.", "On-call page 2: Responder 2 (secondary), acknowledged by pressing 1."]);
  });

  it("treats an answered call without a key press as unacknowledged, and stops after maxEscalations", async () => {
    const policy = loadPolicy();
    const { incident, pages, ports } = await run(heroWith([{ answers: "ignores" }, { answers: "busy" }, { answers: "acknowledges" }]), {
      ...policy,
      oncall: { ...policy.oncall, maxEscalations: 1 },
    });
    // Two responders allowed; the third attempt is refused by the gate, and audited. (An allowed call is logged when it
    // finishes, a refusal at once, so the log's order can differ from the attempts'.)
    const byAttempt = [...pages].sort((a, b) => a.argsSummary.localeCompare(b.argsSummary));
    expect(byAttempt.map((p) => p.decision)).toEqual(["allowed", "allowed", "denied"]);
    expect(byAttempt[2]?.reason).toBe("no escalations left: 2 responders were already paged");
    expect(incident?.paging).toMatchObject({ status: "exhausted" });
    expect(incident?.paging?.attempts.map((a) => a.state)).toEqual(["not_acknowledged", "busy"]);
    // Whether the ticket was filed before or after paging ran out, the record says so: in its description or in a note.
    const record = ports.record.incidents[0]!;
    const all = [record.description, ...record.notes].join("\n");
    expect(all).not.toMatch(/acknowledged by pressing/);
    expect(all).toMatch(/no escalations left: 2 responders were already paged/);
  });

  it("stops when the schedule runs out of people before the escalations do", async () => {
    const { incident } = await run(heroWith([{ answers: "no_answer" }]));
    expect(incident?.paging).toMatchObject({ status: "exhausted", note: "Nobody left on call for checkout-service to escalate to" });
  });

  it("says so when nobody on call can be phoned", async () => {
    const { incident, state } = await run(heroWith([]));
    expect(incident?.paging).toMatchObject({ status: "no_responder", attempts: [] });
    expect(Object.values(state.calls)).toHaveLength(0);
  });

  it("pages no one for a P2 incident or a burst that isn't an incident", async () => {
    for (const id of ["upi-provider-outage", "lookalike-checkout-questions", "quiet-day"]) {
      const { pages, incident, state } = await run(scenarios.get(id)!);
      expect(pages, id).toHaveLength(0);
      expect(incident?.paging, id).toBeUndefined();
      expect(Object.values(state.calls).filter((c) => c.purpose === "oncall"), id).toHaveLength(0);
    }
  });

  it("refuses a page the importance doesn't call for, a repeated attempt, and one out of order", async () => {
    const upi = await run(scenarios.get("upi-provider-outage")!);
    const id = upi.incident!.id;
    expect(await upi.engine.gate.call("commander", "page_on_call", { incidentId: id, attempt: 1 })).toMatchObject({
      ok: false,
      reason: `${id} is P2, below the level that pages on-call`,
    });
    const { engine, incident } = await run(heroWith([{ answers: "no_answer" }, { answers: "no_answer" }, { answers: "no_answer" }]));
    expect(await engine.gate.call("commander", "page_on_call", { incidentId: incident!.id, attempt: 2 })).toMatchObject({ ok: false, reason: "attempt 2 was already made" });
    expect(await engine.gate.call("commander", "page_on_call", { incidentId: incident!.id, attempt: 9 })).toMatchObject({ ok: false, reason: "attempt 4 comes first" });
    expect(await engine.gate.call("recovery", "page_on_call", { incidentId: incident!.id, attempt: 4 })).toMatchObject({ ok: false });
  });

  it("lets an operator acknowledge, which stops paging, and says when nobody was paged", async () => {
    const { engine, incident, ports } = await run(heroWith([{ answers: "no_answer" }]));
    expect(incident?.paging?.status).toBe("exhausted");
    await engine.acknowledgePage(incident!.id, "Asha (Freshservice)");
    expect(engine.snapshot().incidents[incident!.id]?.paging).toMatchObject({ status: "acknowledged", acknowledgedBy: "Asha (Freshservice)", via: "operator" });
    expect(ports.record.incidents[0]?.notes.at(-1)).toBe("On-call page acknowledged by Asha (Freshservice).");
    expect(await engine.gate.call("commander", "page_on_call", { incidentId: incident!.id, attempt: 2 })).toMatchObject({ ok: false, reason: "already acknowledged by Asha (Freshservice)" });

    const upi = await run(scenarios.get("upi-provider-outage")!);
    await expect(upi.engine.acknowledgePage(upi.incident!.id, "Asha")).rejects.toThrow(/nobody has been paged/);
  });
});
