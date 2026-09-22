import type { CorrelationConfig, Surface, Ticket } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import type { Embedder } from "../ports";
import { PatternEngine } from "./pattern";
import type { Prototypes } from "./prototypes";

const cfg: CorrelationConfig = {
  windowMin: 15,
  edgeThreshold: 0.5,
  joinThreshold: 0.5,
  cohesionMin: 0.55,
  sizeMin: 4,
  failureShareMin: 0.75,
  burstPMax: 0.001,
  baselineFloorPerHour: 3,
  surfaceMin: 0.35,
  semanticWeight: 0.5,
  surfaceTemperature: 0.03,
  questionPenalty: 0.3,
};

// Dimensions: 0 checkout, 1 login, 2 delivery, 3 refunds, 4 app, 5 "something broke", 6 "a question", 7 per-ticket noise.
const DIM = 8;
function vec(parts: Record<number, number>): Float32Array {
  const v = new Float32Array(DIM);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const prototypes: Prototypes = {
  surfaces: {
    checkout_payments: ["P_CHECKOUT"],
    login_account: ["P_LOGIN"],
    delivery_orders: ["P_DELIVERY"],
    refunds_billing: ["P_REFUNDS"],
    app_performance: ["P_APP"],
  },
  failure: ["P_FAIL"],
  question: ["P_QUESTION"],
};

const table: Record<string, Float32Array> = {
  P_CHECKOUT: vec({ 0: 1 }),
  P_LOGIN: vec({ 1: 1 }),
  P_DELIVERY: vec({ 2: 1 }),
  P_REFUNDS: vec({ 3: 1 }),
  P_APP: vec({ 4: 1 }),
  P_FAIL: vec({ 5: 1 }),
  P_QUESTION: vec({ 6: 1 }),
};

// Checkout failures: cosine ~0.99 with each other. Checkout questions: ~0.61 with the failures.
// A login failure: ~0.39 with a checkout failure, below the 0.5 edge threshold.
for (let i = 0; i < 12; i++) table[`checkout-fail-${i}`] = vec({ 0: 1, 5: 0.8, 7: 0.05 * i });
for (let i = 0; i < 8; i++) table[`checkout-question-${i}`] = vec({ 0: 1, 6: 0.8, 7: 0.05 * i });
table["login-fail"] = vec({ 1: 1, 5: 0.8 });

const embedder: Embedder = {
  id: "stub",
  async embed(texts) {
    return texts.map((t) => {
      const v = table[t];
      if (!v) throw new Error(`stub embedder has no vector for "${t}"`);
      return v;
    });
  },
};

let n = 0;
function ticket(body: string, atSec: number): Ticket {
  n += 1;
  return { id: `t${n}`, source: "sandbox", customerRef: `c${n}`, customerName: `C${n}`, channel: "chat", body, receivedAt: atSec * 1000 };
}

async function engine(baselinePerHour?: Partial<Record<Surface, number>>) {
  const e = new PatternEngine(embedder, cfg, { prototypes, baselinePerHour });
  await e.init();
  return e;
}

describe("PatternEngine", () => {
  it("classifies a checkout failure and a checkout question", async () => {
    const e = await engine();
    const fail = await e.ingest(ticket("checkout-fail-0", 0));
    const question = await e.ingest(ticket("checkout-question-0", 5));
    expect(fail.signal).toMatchObject({ surface: "checkout_payments", isFailure: true });
    expect(question.signal).toMatchObject({ surface: "checkout_payments", isFailure: false });
  });

  it("fires on the fourth similar checkout failure within 30 seconds, not before", async () => {
    const e = await engine();
    const results = [];
    for (const [i, at] of [0, 7, 14, 18].entries()) results.push(await e.ingest(ticket(`checkout-fail-${i}`, at)));
    expect(results.map((r) => r.fires)).toEqual([false, false, false, true]);
    expect(results[3]?.candidate?.memberTicketIds).toHaveLength(4);
    expect(results[3]?.candidate?.dominantSurface).toBe("checkout_payments");
  });

  it("does not fire on two similar failures, and says it needs more", async () => {
    const e = await engine();
    await e.ingest(ticket("checkout-fail-0", 0));
    const second = await e.ingest(ticket("checkout-fail-1", 5));
    expect(second.fires).toBe(false);
    expect(second.candidate?.gates.find((g) => g.name === "size")?.pass).toBe(false);
  });

  it("refuses five checkout questions and one failure on failure share", async () => {
    const e = await engine();
    let last;
    for (let i = 0; i < 5; i++) last = await e.ingest(ticket(`checkout-question-${i}`, i * 90));
    last = await e.ingest(ticket("checkout-fail-0", 480));
    expect(last.fires).toBe(false);
    expect(last.candidate?.memberTicketIds).toHaveLength(6);
    const share = last.candidate?.gates.find((g) => g.name === "failure_share");
    expect(share?.pass).toBe(false);
    expect(share?.reason).toContain("5 of 6");
  });

  it("forgets failures older than the window", async () => {
    const e = await engine();
    for (const [i, at] of [0, 5, 10].entries()) await e.ingest(ticket(`checkout-fail-${i}`, at));
    await e.ingest(ticket("checkout-fail-3", 20 * 60));
    const last = await e.ingest(ticket("checkout-fail-4", 20 * 60 + 5));
    expect(last.fires).toBe(false);
    expect(last.candidate?.memberTicketIds).toHaveLength(2);
  });

  it("uses the scenario's normal volume: at 120 failures an hour, four in 18 seconds is not a burst", async () => {
    const e = await engine({ checkout_payments: 120 });
    let last;
    for (const [i, at] of [0, 7, 14, 18].entries()) last = await e.ingest(ticket(`checkout-fail-${i}`, at));
    expect(last?.fires).toBe(false);
    expect(last?.candidate?.gates.find((g) => g.name === "burst")?.pass).toBe(false);
  });

  it("joins a later similar failure to the open incident but not an unrelated one", async () => {
    const e = await engine();
    let last;
    for (const [i, at] of [0, 7, 14, 18].entries()) last = await e.ingest(ticket(`checkout-fail-${i}`, at));
    e.attachIncident("INC-1", last?.candidate?.memberTicketIds ?? []);

    const late = await e.ingest(ticket("checkout-fail-5", 60));
    expect(late.joinIncidentId).toBe("INC-1");
    expect(late.fires).toBe(false);
    expect(late.candidate?.memberTicketIds).toHaveLength(5);
    expect(late.candidate?.incidentId).toBe("INC-1");

    const unrelated = await e.ingest(ticket("login-fail", 70));
    expect(unrelated.joinIncidentId).toBeUndefined();
  });

  it("reports the nearest earlier ticket with its hybrid similarity", async () => {
    const e = await engine();
    const first = await e.ingest(ticket("checkout-fail-0", 0));
    const second = await e.ingest(ticket("checkout-question-0", 3));
    expect(second.nearest[0]?.ticketId).toBe(first.signal.ticketId);
    // meaning: 1 / 1.64 = 0.6098; product area: both are checkout, so 1; half of each = 0.8049
    expect(second.nearest[0]?.similarity).toBeCloseTo(0.8049, 3);
  });

  it("keeps same-wording failures about different product areas apart", async () => {
    const e = await engine();
    await e.ingest(ticket("checkout-fail-0", 0));
    const login = await e.ingest(ticket("login-fail", 5));
    // meaning: 0.64 / 1.64 = 0.39; product area: checkout vs login, 0; half of each = 0.195
    expect(login.nearest[0]?.similarity).toBeCloseTo(0.195, 2);
  });

  it("shows how much of the cluster's similarity comes from meaning and how much from product area", async () => {
    const e = await engine();
    let last;
    for (const [i, at] of [0, 7, 14, 18].entries()) last = await e.ingest(ticket(`checkout-fail-${i}`, at));
    const c = last?.candidate;
    expect(c?.cohesionParts.area).toBeCloseTo(1, 3);
    expect(c?.cohesion).toBeCloseTo(0.5 * (c?.cohesionParts.meaning ?? 0) + 0.5 * (c?.cohesionParts.area ?? 0), 6);
  });
});
