import { describe, expect, it } from "vitest";
import { parsePolicy } from "./policy";

const base = {
  identities: {
    pattern: { name: "Pattern Agent", maxLevel: 0, tools: ["get_incident"] },
    commander: { name: "Incident Commander", maxLevel: 1, tools: ["open_incident"] },
    investigator: { name: "Investigator", maxLevel: 0, tools: [] },
    issue_creator: { name: "Issue Creator", maxLevel: 1, tools: [] },
    recovery: { name: "Recovery Agent", maxLevel: 2, tools: [] },
    handoff: { name: "Handoff Agent", maxLevel: 3, tools: [] },
    operator: { name: "External MCP client", maxLevel: 0, tools: [] },
  },
  limits: { authorityLimitInr: 5000, perCustomerLimitInr: 500 },
  correlation: {
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
  },
  rca: {
    lookbackHours: 6,
    confidenceFloor: 0.6,
    priors: { deploy: 0.5, provider: 0.25, infra: 0.15, unknown: 0.25 },
    deployGap: { withinMin: 30, withinLr: 6, nearMin: 120, nearLr: 3, farLr: 0.5, afterLr: 0.2 },
    errorRatio: { strongMin: 2, cap: 10, weakMin: 1.2, weakLr: 1, noneLr: 0.3 },
    provider: { operationalLr: 0.1, degradedLr: 8, uncheckedLr: 1 },
    infra: { crashLoopLr: 8, unreadyLr: 4, restartsMin: 5, restartsLr: 2, healthyLr: 0.3, alarmLr: 4, noAlarmLr: 0.6, saturationPercent: 90, saturationLr: 3 },
    methodSpread: { concentratedShare: 0.8, concentratedLr: 2, spreadLr: 0.7 },
  },
  importance: {
    tier1Surfaces: ["checkout_payments"],
    affectedCustomers: { p1: 20, p2: 5 },
    failedValueInr: { p1: 200000, p2: 25000 },
    priorityCustomers: { p1: 3, p2: 1 },
    deployConfidence: 0.8,
    pageAt: "P1",
  },
  issues: { rollbackConfidence: 0.8, problemOnRecovered: true },
  alerts: { openOnCritical: true, joinWindowMin: 60, criticalLr: 4, warningLr: 1.5 },
  oncall: { ackTimeoutMin: 5, maxEscalations: 2 },
  recovery: { affectedLookbackMin: 30, creditInr: { standard: 200, high: 1000 }, highValueInr: 10000 },
};

describe("parsePolicy", () => {
  it("accepts a policy whose tools all exist", () => {
    const policy = parsePolicy(base, ["get_incident", "open_incident"]);
    expect(policy.identities.commander.tools).toEqual(["open_incident"]);
  });

  it("rejects an allow-list naming a tool that does not exist", () => {
    const typo = structuredClone(base);
    typo.identities.pattern.tools = ["get_incidnet"];
    expect(() => parsePolicy(typo, ["get_incident", "open_incident"])).toThrow(/get_incidnet/);
  });

  it("rejects a missing identity", () => {
    const partial = structuredClone(base) as Record<string, unknown>;
    delete (partial.identities as Record<string, unknown>).handoff;
    expect(() => parsePolicy(partial, ["get_incident", "open_incident"])).toThrow();
  });

  it("rejects importance tiers where P2 needs more than P1, and a product area that doesn't exist", () => {
    expect(() => parsePolicy({ ...base, importance: { ...base.importance, affectedCustomers: { p1: 5, p2: 20 } } }, ["get_incident", "open_incident"])).toThrow(/p2 must not be above p1/);
    expect(() => parsePolicy({ ...base, importance: { ...base.importance, tier1Surfaces: ["payroll"] } }, ["get_incident", "open_incident"])).toThrow();
  });
});
