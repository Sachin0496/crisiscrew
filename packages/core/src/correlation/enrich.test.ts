import { describe, expect, it } from "vitest";
import { classify, questionForm, surfaceProfile, type PrototypeVectors } from "./enrich";

describe("questionForm", () => {
  it.each([
    ["How do I apply a coupon code?", true],
    ["Can I pay by UPI at checkout instead of using a card?", true],
    ["Is EMI available as a payment option at checkout", true],
    ["Where is my refund for the shoes I returned last week?", true],
    ["Can't complete payment for my order.", false],
    ["UPI isn't working. Tried twice.", false],
    ["Payment failed but bank shows debit.", false],
  ])("%s -> %s", (text, expected) => {
    expect(questionForm(text)).toBe(expected);
  });
});

// Dimensions: 0 checkout, 1 login, 2 "something broke", 3 "a question"
const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs.map((x) => x / n));
};
const prototypes: PrototypeVectors = {
  surfaces: [
    { surface: "checkout_payments", vectors: [unit(1, 0, 0, 0)] },
    { surface: "login_account", vectors: [unit(0, 1, 0, 0)] },
  ],
  failure: [unit(0, 0, 1, 0)],
  question: [unit(0, 0, 0, 1)],
};
const cfg = { surfaceMin: 0.35, questionPenalty: 0.3 };

describe("classify", () => {
  it("treats a question-shaped ticket with a weak failure signal as a question", () => {
    // failure similarity 0.28, question similarity 0.14: margin 0.14, minus the 0.3 penalty
    const c = classify(unit(1, 0, 0.3, 0.15), "Can I pay with two cards?", prototypes, cfg);
    expect(c.isFailure).toBe(false);
  });

  it("keeps a strongly failing report a failure even when it is phrased as a question", () => {
    const c = classify(unit(1, 0, 1, 0), "Why does my payment keep failing?", prototypes, cfg);
    expect(c.isFailure).toBe(true);
  });

  it("does not penalise the same weak signal without a question form", () => {
    const c = classify(unit(1, 0, 0.3, 0.15), "Payment went through after a retry.", prototypes, cfg);
    expect(c.isFailure).toBe(true);
  });

  it("returns the per-surface scores used for the product-area profile", () => {
    const c = classify(unit(1, 0, 0.5, 0), "Checkout is stuck", prototypes, cfg);
    expect(c.surface).toBe("checkout_payments");
    expect(c.surfaceScores.checkout_payments).toBeGreaterThan(c.surfaceScores.login_account ?? 1);
  });
});

describe("surfaceProfile", () => {
  it("puts almost all weight on a clearly best surface", () => {
    const p = surfaceProfile({ checkout_payments: 0.7, login_account: 0.2 }, 0.03, 0.35);
    expect(p.checkout_payments).toBeGreaterThan(0.99);
  });

  it("splits weight between two nearly equal surfaces", () => {
    const p = surfaceProfile({ checkout_payments: 0.5, login_account: 0.49 }, 0.03, 0.35);
    // exp(0) / (exp(0) + exp(-1/3)) = 0.5826
    expect(p.checkout_payments).toBeCloseTo(0.5826, 3);
  });

  it("is empty when no surface reaches the minimum, so unknown tickets match on meaning alone", () => {
    const p = surfaceProfile({ checkout_payments: 0.3, login_account: 0.2 }, 0.03, 0.35);
    expect(Object.values(p).every((x) => x === 0)).toBe(true);
  });
});
