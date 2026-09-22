import type { CorrelationConfig } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { clusterComponents, meanPairwiseSimilarity } from "./cluster";
import { extractEntities } from "./enrich";
import { evaluateGates, humanOdds } from "./gates";

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

describe("clusterComponents", () => {
  it("joins a chain A~B~C into one component and leaves D alone", () => {
    const sim: Record<string, number> = { "A|B": 0.8, "B|C": 0.7, "A|C": 0.2, "A|D": 0.1, "B|D": 0.1, "C|D": 0.1 };
    const lookup = (a: string, b: string) => sim[`${a}|${b}`] ?? sim[`${b}|${a}`] ?? 0;
    const components = clusterComponents(["A", "B", "C", "D"], lookup, 0.5);
    const sorted = components.map((c) => [...c].sort()).sort((x, y) => y.length - x.length);
    expect(sorted).toEqual([["A", "B", "C"], ["D"]]);
  });

  it("exposes chaining: the chain's mean pairwise similarity is below its strongest link", () => {
    const sim: Record<string, number> = { "A|B": 0.8, "B|C": 0.7, "A|C": 0.2 };
    const lookup = (a: string, b: string) => sim[`${a}|${b}`] ?? sim[`${b}|${a}`] ?? 0;
    // (0.8 + 0.7 + 0.2) / 3
    expect(meanPairwiseSimilarity(["A", "B", "C"], lookup)).toBeCloseTo(0.5667, 4);
  });
});

describe("evaluateGates", () => {
  const strong = {
    size: 5,
    cohesion: 0.72,
    failureCount: 5,
    spanSec: 30,
    baselinePerHour: 3,
  };

  it("passes all four gates for five similar failures in 30 seconds", () => {
    const { gates, fires, burstP } = evaluateGates(strong, cfg);
    expect(gates.map((g) => [g.name, g.pass])).toEqual([
      ["size", true],
      ["cohesion", true],
      ["failure_share", true],
      ["burst", true],
    ]);
    expect(fires).toBe(true);
    expect(burstP).toBeCloseTo(2.497951336e-9, 17);
  });

  it("refuses three tickets on size, and says how many it needs", () => {
    const { gates, fires } = evaluateGates({ ...strong, size: 3, failureCount: 3 }, cfg);
    const size = gates.find((g) => g.name === "size");
    expect(size?.pass).toBe(false);
    expect(size?.reason).toContain("3");
    expect(size?.reason).toContain("4");
    expect(fires).toBe(false);
  });

  it("refuses a burst of questions on failure share, naming how many are questions", () => {
    const { gates, fires } = evaluateGates({ ...strong, size: 6, failureCount: 1 }, cfg);
    const share = gates.find((g) => g.name === "failure_share");
    expect(share?.pass).toBe(false);
    expect(share?.value).toBeCloseTo(1 / 6, 6);
    expect(share?.reason).toContain("5 of 6");
    expect(fires).toBe(false);
  });

  it("refuses unrelated complaints on cohesion", () => {
    const { gates } = evaluateGates({ ...strong, cohesion: 0.31 }, cfg);
    const cohesion = gates.find((g) => g.name === "cohesion");
    expect(cohesion?.pass).toBe(false);
    expect(cohesion?.reason).toContain("0.31");
  });

  it("refuses failures arriving at the normal rate on the burst test", () => {
    // 5 failures over 15 minutes when 20 an hour is normal: 5 expected, nothing unusual.
    const { gates, fires } = evaluateGates({ ...strong, spanSec: 900, baselinePerHour: 20 }, cfg);
    expect(gates.find((g) => g.name === "burst")?.pass).toBe(false);
    expect(fires).toBe(false);
  });

  it("uses the baseline floor when the observed baseline is lower", () => {
    const low = evaluateGates({ ...strong, baselinePerHour: 0.1 }, cfg);
    const floor = evaluateGates({ ...strong, baselinePerHour: 3 }, cfg);
    expect(low.burstP).toBe(floor.burstP);
  });
});

describe("humanOdds", () => {
  it.each([
    [2.5e-9, "1 in 400 million"],
    [2e-4, "1 in 5 thousand"],
    [0.02, "1 in 50"],
    [0.6, "1 in 2"],
  ])("describes p = %d as %s", (p, text) => {
    expect(humanOdds(p)).toBe(text);
  });
});

describe("extractEntities", () => {
  it("finds payment methods, rupee amounts and order ids", () => {
    const e = extractEntities("UPI failed twice and my card was rejected for ₹1,299 on order #A1B2C3");
    expect(e.paymentMethods.sort()).toEqual(["card", "upi"]);
    expect(e.amounts).toEqual([1299]);
    expect(e.orderIds).toEqual(["A1B2C3"]);
  });

  it("recognises plural cards as a card payment", () => {
    expect(extractEntities("Tried three different cards and it still fails").paymentMethods).toEqual(["card"]);
  });

  it("recognises UPI apps as UPI", () => {
    expect(extractEntities("PhonePe payment stuck at processing").paymentMethods).toEqual(["upi"]);
  });

  it("finds nothing in a complaint without entities", () => {
    expect(extractEntities("My checkout keeps loading forever.")).toEqual({ paymentMethods: [], amounts: [], orderIds: [] });
  });
});
