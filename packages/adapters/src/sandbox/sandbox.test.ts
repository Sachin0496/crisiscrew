import { ScenarioSchema } from "@crisiscrew/contracts";
import { ManualClock } from "@crisiscrew/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSandboxPorts } from "./ports";

const hero = ScenarioSchema.parse(JSON.parse(readFileSync(new URL("../../../../scenarios/checkout-v4.21.7.json", import.meta.url), "utf8")));
const T0 = 1_800_000_000_000;
const MIN = 60_000;

function ports(nowOffsetMs: number) {
  const clock = new ManualClock(T0 + nowOffsetMs);
  return { clock, ports: createSandboxPorts(hero, { t0: T0, clock, latencyMs: 0 }) };
}

describe("sandbox deployments", () => {
  it("returns a service's releases since a time, newest first, without revealing which one is faulty", async () => {
    const { ports: p } = ports(0);
    const recent = await p.deployments.recent("checkout-service", T0 - 6 * 60 * MIN);
    expect(recent.map((d) => d.version)).toEqual(["4.21.7", "4.21.6"]);
    expect(recent[0]).toMatchObject({ sha: "3f9c2e1b7a55", author: "vikram-s", at: T0 - 795_000 });
    expect(Object.keys(recent[0]!)).not.toContain("faulty");
  });

  it("does not show a release that hasn't happened yet", async () => {
    const { ports: p } = ports(-20 * MIN);
    const recent = await p.deployments.recent("checkout-service", T0 - 6 * 60 * MIN);
    expect(recent.map((d) => d.version)).toEqual(["4.21.6"]);
  });
});

describe("sandbox metrics", () => {
  it("raises checkout-service errors after the faulty release by roughly the world's ratio", async () => {
    const { ports: p } = ports(2 * MIN);
    const release = T0 - 795_000;
    const series = await p.metrics.errorRates("checkout-service", release - 60 * MIN, T0 + 2 * MIN);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const before = mean(series.filter((s) => s.at < release).map((s) => s.rate));
    const after = mean(series.filter((s) => s.at >= release).map((s) => s.rate));
    // World: 0.4% baseline, 3.44% after the faulty release, so 8.6x before noise.
    expect(before).toBeGreaterThan(0.003);
    expect(before).toBeLessThan(0.005);
    expect(after / before).toBeGreaterThan(7);
    expect(after / before).toBeLessThan(10);
  });

  it("gives the same series every time (seeded)", async () => {
    const a = await ports(0).ports.metrics.errorRates("checkout-service", T0 - 30 * MIN, T0);
    const b = await ports(0).ports.metrics.errorRates("checkout-service", T0 - 30 * MIN, T0);
    expect(a).toEqual(b);
  });
});

describe("sandbox orders", () => {
  it("lists only payment attempts that have already happened", async () => {
    const early = await ports(0).ports.orders.attemptsSince(T0 - 30 * MIN);
    const later = await ports(90_000).ports.orders.attemptsSince(T0 - 30 * MIN);
    expect(early.every((a) => a.at <= T0)).toBe(true);
    expect(later.length).toBeGreaterThan(early.length);
  });

  it("finds all 23 customers with failed or pending payments by the time the incident opens", async () => {
    const attempts = await ports(63_000).ports.orders.attemptsSince(T0 + 45_000 - 30 * MIN);
    const affected = new Set(attempts.filter((a) => a.status !== "success").map((a) => a.customerRef));
    expect(affected.size).toBe(23);
  });

  it("looks up a customer with tier and consent", async () => {
    expect(await ports(0).ports.orders.customer("s03")).toMatchObject({ name: "Ananya Iyer", tier: "priority", consent: { voice: true } });
    expect(await ports(0).ports.orders.customer("nobody")).toBeNull();
  });

  it("finds a customer by email, ignoring case and spaces, or by exact name", async () => {
    const { ports: p } = ports(0);
    expect((await p.orders.findCustomer({ email: "  Priya.K@Example.com " }))?.ref).toBe("c-priya");
    expect((await p.orders.findCustomer({ name: "ananya iyer" }))?.ref).toBe("s03");
    expect(await p.orders.findCustomer({ email: "judge@example.org" })).toBeNull();
    expect(await p.orders.findCustomer({})).toBeNull();
  });

  it("keeps numbered notes on customers' accounts", async () => {
    const { ports: p } = ports(0);
    expect(await p.orders.addAccountNote("s05", "affected by INC-1")).toEqual({ id: "NOTE-001" });
    expect(p.record.accountNotes).toEqual([{ id: "NOTE-001", customerRef: "s05", text: "affected by INC-1" }]);
  });
});

describe("sandbox engineering incidents", () => {
  it("files a numbered record, changes its importance and adds notes to it", async () => {
    const { ports: p } = ports(0);
    expect(await p.incidents.open({ incidentId: "INC-1", title: "Checkout", description: "d", importance: "P2" })).toEqual({ id: "ENG-001" });
    await p.incidents.setImportance("ENG-001", "P1");
    await p.incidents.note("ENG-001", "root cause");
    expect(p.record.incidents[0]).toMatchObject({ incidentId: "INC-1", importance: "P1", notes: ["root cause"] });
    await expect(p.incidents.note("ENG-404", "x")).rejects.toThrow(/no engineering incident/);
  });
});

describe("sandbox catalog, payments and credits", () => {
  it("maps a product surface to its services", () => {
    expect(ports(0).ports.catalog.servicesFor("checkout_payments").map((s) => s.name)).toEqual(["checkout-service"]);
  });

  it("reports provider health from the world", async () => {
    expect(await ports(0).ports.payments.health()).toEqual([
      expect.objectContaining({ provider: "razorpay", status: "operational" }),
    ]);
  });

  it("numbers issued credits and labels every port as sandbox, voice as off", async () => {
    const { ports: p } = ports(0);
    expect(await p.credits.issue(["s01"], 500, "INC-1")).toEqual({ id: "CR-001" });
    expect(await p.credits.issue(["s02"], 500, "INC-1")).toEqual({ id: "CR-002" });
    expect(p.deployments.mode).toBe("sandbox");
    expect(p.voice.mode).toBe("off");
    expect(await p.voice.synthesize("hello")).toEqual({ audioId: null });
  });
});
