import type { AffectedCustomer, CustomerImpact, Hypothesis, ImportanceAssessment, ImportanceConfig, IncidentView } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { assessImportance, higher, nextImportance } from "./assess";

const config: ImportanceConfig = {
  tier1Surfaces: ["checkout_payments", "login_account"],
  affectedCustomers: { p1: 20, p2: 5 },
  failedValueInr: { p1: 200_000, p2: 25_000 },
  priorityCustomers: { p1: 3, p2: 1 },
  deployConfidence: 0.8,
  pageAt: "P1",
};

function customer(i: number, change: Partial<AffectedCustomer> = {}): AffectedCustomer {
  return {
    ref: `c${i}`,
    name: `Customer ${i}`,
    tier: "standard",
    consent: { proactive: true, voice: false },
    complained: false,
    ticketIds: [],
    confidence: "confirmed",
    severity: "medium",
    failedAttempts: 1,
    amountInr: 1_000,
    methods: ["upi"],
    paidOnRetry: false,
    evidence: [],
    ...change,
  };
}

const impact = (customers: AffectedCustomer[]): CustomerImpact => ({ since: 0, assessedAt: 0, customers });
const many = (n: number, change: Partial<AffectedCustomer> = {}) => Array.from({ length: n }, (_, i) => customer(i, change));

type Input = Pick<IncidentView, "surface" | "impact" | "rootCause" | "hypotheses">;
const incident = (change: Partial<Input> = {}): Input => ({ surface: "delivery_orders", hypotheses: [], ...change });

const rules = (input: Input) => assessImportance(input, [], config).reasons.map((r) => `${r.rule}:${r.level}`);

describe("assessImportance", () => {
  it("is P3 with no reasons when no rule fires, and doesn't page", () => {
    expect(assessImportance(incident(), [], config)).toEqual({ level: "P3", page: false, reasons: [] });
  });

  it("counts confirmed affected customers only: 5 is P2, 20 is P1", () => {
    expect(rules(incident({ impact: impact(many(4)) }))).toEqual([]);
    expect(rules(incident({ impact: impact(many(5)) }))).toEqual(["affected_customers:P2"]);
    expect(rules(incident({ impact: impact([...many(19), customer(99, { confidence: "unverified" })]) }))).toEqual(["affected_customers:P2"]);
    const p1 = assessImportance(incident({ impact: impact(many(20)) }), [], config);
    expect(p1).toMatchObject({ level: "P1", page: true });
    expect(p1.reasons[0]?.text).toBe("20 customers affected (20 or more is P1)");
  });

  it("adds up the failed payments of confirmed customers", () => {
    expect(rules(incident({ impact: impact([customer(1, { amountInr: 25_000 })]) }))).toEqual(["failed_value:P2"]);
    const big = assessImportance(incident({ impact: impact([customer(1, { amountInr: 150_000 }), customer(2, { amountInr: 50_000 })]) }), [], config);
    expect(big.reasons[0]).toEqual({ rule: "failed_value", level: "P1", text: "₹2,00,000 in failed or pending payments (₹2,00,000 or more is P1)" });
  });

  it("raises for priority customers: one is P2, three is P1", () => {
    expect(rules(incident({ impact: impact([customer(1, { tier: "priority" })]) }))).toEqual(["priority_customers:P2"]);
    expect(assessImportance(incident({ impact: impact(many(3, { tier: "priority" })) }), [], config).level).toBe("P1");
  });

  it("makes a tier-1 product area at least P2", () => {
    expect(assessImportance(incident({ surface: "checkout_payments" }), [], config)).toMatchObject({
      level: "P2",
      page: false,
      reasons: [{ rule: "tier1_surface", level: "P2", text: "Checkout & payments is a tier-1 area" }],
    });
    expect(rules(incident({ surface: "login_account" }))).toEqual(["tier1_surface:P2"]);
  });

  it("raises for a release ranked as the cause with enough confidence, not for a provider or a weak ranking", () => {
    const deploy: Hypothesis = { id: "deploy:x@1", kind: "deploy", subject: "x", label: "x v1", prior: 0.25, evidence: [], score: 1, confidence: 0.9 };
    const provider: Hypothesis = { ...deploy, id: "provider:razorpay", kind: "provider" };
    expect(rules(incident({ hypotheses: [deploy], rootCause: { hypothesisId: deploy.id, label: "x v1", confidence: 0.9 } }))).toEqual(["deploy_cause:P2"]);
    expect(rules(incident({ hypotheses: [deploy], rootCause: { hypothesisId: deploy.id, label: "x v1", confidence: 0.7 } }))).toEqual([]);
    expect(rules(incident({ hypotheses: [provider], rootCause: { hypothesisId: provider.id, label: "Razorpay", confidence: 0.95 } }))).toEqual([]);
  });

  it("raises for alerts: critical is P1, a warning is P2", () => {
    const critical = assessImportance(incident(), [{ severity: "critical", service: "checkout-service", label: "CPU above 95% for 5 minutes" }], config);
    expect(critical).toMatchObject({ level: "P1", page: true, reasons: [{ text: "Critical alert on checkout-service: CPU above 95% for 5 minutes" }] });
    expect(assessImportance(incident(), [{ severity: "warning", service: "checkout-service", label: "latency" }], config).level).toBe("P2");
  });

  it("lists the most urgent reasons first, and pages at the configured level", () => {
    const input = incident({ surface: "checkout_payments", impact: impact(many(20)) });
    expect(rules(input)).toEqual(["affected_customers:P1", "tier1_surface:P2"]);
    expect(assessImportance(input, [], { ...config, pageAt: "P2" }).page).toBe(true);
    expect(assessImportance(incident({ surface: "checkout_payments" }), [], { ...config, pageAt: "P2" }).page).toBe(true);
  });
});

describe("nextImportance", () => {
  const at = (level: ImportanceAssessment["level"], change: Partial<ImportanceAssessment> = {}): ImportanceAssessment => ({
    level,
    page: level === "P1",
    reasons: [{ rule: "r", level, text: level }],
    stage: "impact",
    source: "rules",
    assessedAt: 0,
    ...change,
  });

  it("takes the first assessment, and any higher one", () => {
    expect(nextImportance(undefined, at("P3"))).toEqual(at("P3"));
    expect(nextImportance(at("P2"), at("P1"))?.level).toBe("P1");
  });

  it("never lowers the level on its own", () => {
    expect(nextImportance(at("P1"), at("P2"))).toBeNull();
  });

  it("refreshes the reasons at the same level, and skips an assessment that changes nothing", () => {
    const more = at("P2", { reasons: [{ rule: "r", level: "P2", text: "P2" }, { rule: "s", level: "P2", text: "more" }] });
    expect(nextImportance(at("P2"), more)).toBe(more);
    expect(nextImportance(at("P2"), at("P2", { assessedAt: 5 }))).toBeNull();
  });

  it("leaves a human's decision alone, even when the rules would raise it", () => {
    expect(nextImportance(at("P3", { source: "human", by: "Asha" }), at("P1"))).toBeNull();
  });

  it("orders levels by urgency", () => {
    expect(higher("P1", "P2")).toBe(true);
    expect(higher("P3", "P2")).toBe(false);
  });
});
