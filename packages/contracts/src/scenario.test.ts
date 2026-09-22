import { describe, expect, it } from "vitest";
import { parseOffset, ScenarioSchema } from "./scenario";

describe("parseOffset", () => {
  it.each([
    ["-14m", -840_000],
    ["+30s", 30_000],
    ["2h", 7_200_000],
    ["0s", 0],
    ["1.5m", 90_000],
    ["250ms", 250],
  ])("parses %s as %i ms", (text, ms) => {
    expect(parseOffset(text)).toBe(ms);
  });

  it("rejects text without a unit", () => {
    expect(() => parseOffset("14")).toThrow(/offset/i);
  });
});

const minimal = {
  id: "tiny",
  title: "Tiny",
  purpose: "schema test",
  expected: { incident: false },
  world: {
    services: [{ name: "checkout-service", surfaces: ["checkout_payments"] }],
    deployments: [],
    providers: [],
    customers: [{ ref: "c1", name: "Asha" }],
    attempts: [],
  },
  tickets: [{ at: "+0s", customerRef: "c1", channel: "chat", body: "Checkout is stuck" }],
};

describe("ScenarioSchema", () => {
  it("fills defaults for consent, tier and speed", () => {
    const s = ScenarioSchema.parse(minimal);
    expect(s.speed).toBe(1);
    expect(s.world.customers[0]).toMatchObject({ tier: "standard", consent: { voice: false, proactive: false } });
  });

  it("rejects a ticket whose customer is not in the world", () => {
    const bad = { ...minimal, tickets: [{ ...minimal.tickets[0], customerRef: "ghost" }] };
    const result = ScenarioSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ghost");
  });

  it("rejects a payment attempt whose customer is not in the world", () => {
    const bad = {
      ...minimal,
      world: { ...minimal.world, attempts: [{ customerRef: "nobody", at: "-1m", method: "upi", status: "failed", amountInr: 100 }] },
    };
    expect(ScenarioSchema.safeParse(bad).success).toBe(false);
  });
});
