import { parsePolicy, TOOL_NAMES } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import policyJson from "../../../../config/policy.json";
import type { Deployment, ErrorRatePoint, ProviderHealth } from "../ports";
import { scoreHypotheses, type RcaInput } from "./score";

const rca = parsePolicy(policyJson, TOOL_NAMES).rca;
const MIN = 60_000;
const FIRST = 100 * MIN; // first complaint

const release = (version: string, minutesBefore: number): Deployment => ({
  service: "checkout-service",
  version,
  sha: `${version.replace(/\./g, "")}abcdef`,
  author: "vikram-s",
  at: FIRST - minutesBefore * MIN,
  message: "change",
  environment: "production",
});

/** One point a minute: `before` until the step, `after` from it on. */
function stepSeries(stepAt: number, before: number, after: number, from: number, to: number): ErrorRatePoint[] {
  const points: ErrorRatePoint[] = [];
  for (let t = from; t <= to; t += MIN) points.push({ at: t, rate: t < stepAt ? before : after });
  return points;
}

const operational: ProviderHealth[] = [
  { provider: "razorpay", status: "operational", components: [{ name: "Payments API", status: "operational" }], detail: "" },
];

function input(over: Partial<RcaInput>): RcaInput {
  return {
    firstComplaintAt: FIRST,
    deployments: [],
    errorSeries: {},
    providers: operational,
    paymentMethods: [],
    adapters: { deployments: "sandbox", metrics: "sandbox", payments: "sandbox" },
    ...over,
  };
}

describe("scoreHypotheses", () => {
  it("blames a release 14 minutes before the complaints with an 8.6x error spike", () => {
    const r = release("4.21.7", 14);
    const hypotheses = scoreHypotheses(
      input({
        deployments: [r],
        errorSeries: { "checkout-service": stepSeries(r.at, 0.004, 0.0344, r.at - 60 * MIN, FIRST + 2 * MIN) },
        paymentMethods: [["upi"], ["card"], ["card"], []],
      }),
      rca,
    );
    // release: 0.5 x 6 (14 min gap) x 8.6 (error ratio) = 25.8
    // gateway: 0.25 x 0.1 (operational) x 0.7 (methods spread) = 0.0175; unknown: 0.25
    expect(hypotheses[0]).toMatchObject({ id: "deploy:checkout-service@4.21.7", kind: "deploy" });
    expect(hypotheses[0]?.score).toBeCloseTo(25.8, 6);
    expect(hypotheses[0]?.confidence).toBeCloseTo(25.8 / 26.0675, 6);
    const ratio = hypotheses[0]?.evidence.find((e) => e.source === "get_service_status");
    expect(ratio?.lr).toBeCloseTo(8.6, 6);
    expect(ratio?.observation).toContain("8.6×");
  });

  it("ranks the recent release above an older one", () => {
    const recent = release("4.21.7", 14);
    const older = release("4.21.6", 300);
    const [first, second] = scoreHypotheses(
      input({
        deployments: [recent, older],
        errorSeries: { "checkout-service": stepSeries(recent.at, 0.004, 0.0344, older.at - 60 * MIN, FIRST) },
      }),
      rca,
    );
    expect(first?.id).toBe("deploy:checkout-service@4.21.7");
    expect(second?.id).not.toBe("deploy:checkout-service@4.21.6");
  });

  it("blames the payment provider when there was no release and it reports UPI degraded", () => {
    const hypotheses = scoreHypotheses(
      input({
        deployments: [],
        providers: [{ provider: "razorpay", status: "degraded", components: [], detail: "UPI degraded" }],
        paymentMethods: [["upi"], ["upi"], ["upi"], ["upi"], [], ["upi"]],
      }),
      rca,
    );
    // provider: 0.25 x 8 (degraded) x 2 (all complaints naming a method name UPI) = 4; unknown 0.25
    expect(hypotheses[0]).toMatchObject({ id: "provider:razorpay", kind: "provider" });
    expect(hypotheses[0]?.confidence).toBeCloseTo(4 / 4.25, 6);
  });

  it("treats a failed check as unchecked evidence with no weight", () => {
    const hypotheses = scoreHypotheses(input({ providers: null, errorSeries: null, deployments: [release("4.21.7", 14)] }), rca);
    const provider = hypotheses.find((h) => h.kind === "provider");
    expect(provider?.evidence[0]).toMatchObject({ checked: false, lr: 1 });
    const deploy = hypotheses.find((h) => h.kind === "deploy");
    expect(deploy?.evidence.find((e) => e.source === "get_service_status")).toMatchObject({ checked: false, lr: 1 });
  });

  it("considers a release that shipped after the first complaint unlikely", () => {
    const [deploy] = scoreHypotheses(input({ deployments: [release("4.21.8", -5)], errorSeries: {} }), rca).filter(
      (h) => h.kind === "deploy",
    );
    expect(deploy?.evidence.find((e) => e.source === "get_recent_deployments")?.lr).toBe(0.2);
  });

  it("gives confidences that sum to 1 and always keeps an 'unknown' hypothesis", () => {
    const hypotheses = scoreHypotheses(input({ deployments: [release("4.21.7", 14), release("4.21.6", 300)] }), rca);
    expect(hypotheses.reduce((s, h) => s + h.confidence, 0)).toBeCloseTo(1, 10);
    expect(hypotheses.some((h) => h.kind === "unknown")).toBe(true);
  });
});
