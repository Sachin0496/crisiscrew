import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import { actionsFor, recoveryCoverage, type Scenario } from "@crisiscrew/contracts";
import { callMenu, CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const scenarios = loadScenarios();
const hero = scenarios.get("checkout-v4.21.7")!;
/** 19:42 in Kolkata: inside calling hours. */
const EVENING = Date.UTC(2026, 8, 25, 14, 12, 0);
/** 23:30 in Kolkata: outside them. */
const NIGHT = Date.UTC(2026, 8, 25, 18, 0, 0);

/** The hero, with Ananya's answer on the phone changed. */
function heroWhereAnanya(press: "1" | "2" | "3"): Scenario {
  const customers = hero.world.customers.map((c) => (c.ref === "s03" ? { ...c, onCall: { answers: "answers" as const, press } } : c));
  return { ...hero, world: { ...hero.world, customers } };
}

async function run(scenario: Scenario, t0 = EVENING) {
  const clock = new ManualClock(t0);
  const ports = createSandboxPorts(scenario, { t0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports,
    embedder,
    clock,
    policy: loadPolicy(),
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: scenario.id, speed: 1 },
  });
  await engine.init();
  for (const t of scenarioTickets(scenario, t0)) {
    clock.set(t.receivedAt);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.receivedAt });
    await engine.whenIdle();
  }
  // Calls finish on the scenario clock after the last ticket; let them, and any retries, play out.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await engine.whenIdle();
  }
  const state = engine.snapshot();
  return { engine, ports, state, incident: state.incidents[state.incidentOrder[0]!]! };
}

const voice = (incident: ReturnType<typeof Object>, ref: string) => actionsFor(incident as never, ref).find((a) => a.kind === "voice")!;

describe("calling affected customers", () => {
  it("calls with the track's script and a menu; Ananya answers, presses 1 and hears her own payment's status", async () => {
    const { incident, ports, state } = await run(hero);
    const call = ports.record.calls.find((c) => c.purpose === "customer" && c.to === "+919000000003")!;
    expect(call.script).toMatch(/^Hello Ananya, this is customer care\. You may not have noticed, but your ₹12,999 card payment at \d\d:\d\d didn't go through today\./);
    expect(voice(incident, "s03")).toMatchObject({ status: "done", attempts: 1, detail: expect.stringMatching(/answered \(\d+ s\); heard the status$/) });
    expect(Object.values(state.calls).find((c) => c.metadata?.customerRef === "s03")).toMatchObject({ state: "completed", digits: "1" });
    // Silent, so the summary goes on her account.
    expect(ports.record.accountNotes.map((n) => n.text)).toContainEqual(expect.stringMatching(/^CrisisCrew · INC-2026-001 · Called Ananya Iyer \(\d+ s\): answered, pressed 1 and heard their payment and credit status\.$/));
  });

  it("calls again when nobody answers, then marks the customer not reached, and coverage still settles", async () => {
    const { incident, ports } = await run(hero);
    expect(ports.record.calls.filter((c) => c.to === "+919000000009")).toHaveLength(3);
    expect(voice(incident, "s09")).toMatchObject({ status: "unreached", attempts: 3, detail: expect.stringMatching(/no answer; not reached after 3 calls$/) });
    expect(ports.record.accountNotes.map((n) => n.text)).toContain("CrisisCrew · INC-2026-001 · Farhan Qureshi wasn't reached by phone after 3 calls (no answer). The written update stands.");
    expect(recoveryCoverage(incident)).toMatchObject({ confirmed: 23, recovered: 21, needsHuman: 2 });
  });

  it("asks for a callback when the customer presses 2, and stops calling when they press 3", async () => {
    const callback = await run(heroWhereAnanya("2"));
    expect(callback.ports.record.accountNotes.map((n) => n.text)).toContainEqual(expect.stringMatching(/pressed 2: asked for a person to call them back\. Please call them back\.$/));

    const stop = await run(heroWhereAnanya("3"));
    expect(stop.ports.record.consentWithdrawn).toEqual([{ customerRef: "s03", channel: "voice" }]);
    expect(stop.engine.audit.entries().find((e) => e.tool === "record_contact_preference")).toMatchObject({ identity: "handoff", decision: "allowed" });
    expect((await stop.ports.orders.customer("s03"))?.consent.voice).toBe(false);
  });

  it("refuses a second call to someone already reached, and a script that promises a credit amount nobody issued", async () => {
    const { engine, incident } = await run(hero);
    const call = (text: string) => engine.gate.call("handoff", "send_customer_update", { incidentId: incident.id, customerRef: "s03", channel: "voice", text });
    expect(await call("Hello again")).toMatchObject({ ok: false, reason: "this customer was already reached by phone about this incident" });
    expect(await engine.gate.call("handoff", "send_customer_update", { incidentId: incident.id, customerRef: "s09", channel: "voice", text: "Your ₹8,999 payment failed." })).toMatchObject({
      ok: false,
      reason: "already called 3 times, the most allowed",
    });
  });

  it("refuses a call script that promises a credit amount nobody issued, but lets it name the customer's own payment", async () => {
    // Farhan without a phone number: his voice update is only prepared, so he has never been called.
    const customers = hero.world.customers.map((c) => (c.ref === "s09" ? { ...c, phone: undefined, onCall: undefined } : c));
    const { engine, incident } = await run({ ...hero, world: { ...hero.world, customers } });
    const call = (text: string) => engine.gate.call("handoff", "send_customer_update", { incidentId: incident.id, customerRef: "s09", channel: "voice", text });
    expect(await call("Sorry. We'll give you a ₹1,000 credit today.")).toMatchObject({ ok: false, reason: "the call can't promise a credit amount that hasn't been issued" });
    expect(await call("Your ₹8,999 netbanking payment didn't go through. A credit is being reviewed.")).toMatchObject({ ok: true });
  });

  it("calls no one outside calling hours; the written update stands and nobody is left needing attention", async () => {
    const { incident, state } = await run(hero, NIGHT);
    expect(Object.values(state.calls).filter((c) => c.purpose === "customer")).toHaveLength(0);
    expect(voice(incident, "s03")).toMatchObject({ status: "unreached", detail: "Not called: outside calling hours (09:00 to 21:00, Asia/Kolkata)" });
    expect(recoveryCoverage(incident).attention).toBe(0);
  });
});

describe("the call menu", () => {
  const customer = { name: "Ananya Iyer", amountInr: 12_999, methods: ["card" as const], lastFailedAt: Date.UTC(2026, 8, 25, 7, 55), paidOnRetry: false };
  it("names an issued credit with its amount, a credit under review without one, and offers three keys", () => {
    const base = { id: "a", incidentId: "i", customerRef: "s03", kind: "credit" as const, reason: "", level: 3 as const, updatedAt: 0, amountInr: 1_000 };
    expect(callMenu(customer, { ...base, status: "done" }).replies["1"]).toBe(
      "Your ₹12,999 card payment at 13:25 didn't go through. If money left your account, your bank will reverse it automatically. A goodwill credit of ₹1,000 has been added to your account. Thank you, goodbye.",
    );
    const review = callMenu(customer, { ...base, status: "awaiting_approval" });
    expect(review.replies["1"]).toContain("A goodwill credit for you is being reviewed");
    expect(review.replies["1"]).not.toContain("₹1,000");
    expect(Object.keys(review.replies)).toEqual(["1", "2", "3"]);
    expect(review.prompt).toBe("Press 1 to hear the status of your payment, 2 to have a person call you back, or 3 to stop these calls.");
  });
});
