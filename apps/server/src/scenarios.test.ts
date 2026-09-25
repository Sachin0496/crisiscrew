import { describe, expect, it } from "vitest";
import { loadPolicy, loadScenarios } from "./scenarios";

describe("loadScenarios", () => {
  it("loads every scenario file, each under an id matching its file name", () => {
    const scenarios = loadScenarios();
    expect([...scenarios.keys()].sort()).toEqual([
      "alert-before-complaints",
      "checkout-v4.21.7",
      "lookalike-checkout-questions",
      "noisy-alert",
      "quiet-day",
      "scattered-failures",
      "two-card-complaints",
      "upi-provider-outage",
    ]);
  });

  it("names the file when a scenario is invalid", () => {
    expect(() => loadScenarios(new URL("./__fixtures__/bad-scenarios/", import.meta.url))).toThrow(/broken\.json/);
  });
});

describe("loadPolicy", () => {
  it("loads config/policy.json and every tool it names exists", () => {
    const policy = loadPolicy();
    expect(policy.limits.authorityLimitInr).toBeGreaterThan(0);
    expect(policy.identities.pattern.maxLevel).toBe(0);
  });
});
