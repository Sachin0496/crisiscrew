import { ScenarioSchema } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { loadPools } from "../corpus";
import { generateRuns, generateStressRuns, RUN_KINDS, type EvalRun } from "./generate";

const pools = loadPools();
const runs = generateRuns(pools, 60);

describe("generateRuns", () => {
  it("is repeatable: the same seeds give the same runs", () => {
    expect(JSON.stringify(generateRuns(pools, 60))).toBe(JSON.stringify(runs));
  });

  it("covers every kind equally and splits runs evenly into tune and test", () => {
    for (const kind of RUN_KINDS) expect(runs.filter((r) => r.kind === kind)).toHaveLength(10);
    expect(runs.filter((r) => r.split === "tune")).toHaveLength(30);
  });

  it("puts every kind in both splits, half each", () => {
    for (const kind of RUN_KINDS) {
      expect(runs.filter((r) => r.kind === kind && r.split === "tune")).toHaveLength(5);
      expect(runs.filter((r) => r.kind === kind && r.split === "test")).toHaveLength(5);
    }
  });

  it("never lets a sentence used for tuning appear in the test split", () => {
    const texts = (split: string) => new Set(runs.filter((r) => r.split === split).flatMap((r) => r.scenario.tickets.map((t) => t.body)));
    const tune = texts("tune");
    const shared = [...texts("test")].filter((t) => tune.has(t));
    expect(shared).toEqual([]);
  });

  it("produces scenarios that pass the real scenario schema", () => {
    for (const run of runs) expect(() => ScenarioSchema.parse(run.scenario)).not.toThrow();
  });

  it("labels 4 to 7 burst tickets in incident runs, drawn from that incident's pool, and none elsewhere", () => {
    for (const run of runs) {
      const labeled = run.scenario.tickets.filter((_, i) => run.labeled.includes(i)).map((t) => t.body);
      if (run.scenario.expected.incident) {
        expect(labeled.length).toBeGreaterThanOrEqual(4);
        expect(labeled.length).toBeLessThanOrEqual(7);
        const pool = pools[`incident-${run.kind.replace("_", "-")}`]!;
        for (const text of labeled) expect(pool).toContain(text);
      } else {
        expect(labeled).toEqual([]);
      }
    }
  });

  it("gives each incident run a world whose true cause matches its expected root cause", () => {
    for (const run of runs.filter((r) => r.scenario.expected.incident)) {
      const expected = run.scenario.expected.rootCause!;
      if (expected.startsWith("deploy:")) {
        const [service, version] = expected.slice("deploy:".length).split("@");
        expect(run.scenario.world.deployments.find((d) => d.service === service && d.version === version)?.faulty).toBe(true);
      } else {
        expect(run.scenario.world.providers[0]?.status).toBe("degraded");
      }
    }
  });
});

describe("generateStressRuns", () => {
  const stressPool = pools["stress-delivery-mix"]!;
  const stress = generateStressRuns(pools, 20);
  const complaints = (run: EvalRun) => run.scenario.tickets.map((t) => t.body).filter((body) => stressPool.includes(body));

  it("puts 4 to 6 different delivery complaints in each run, drawn from the whole pool", () => {
    for (const run of stress) {
      const c = complaints(run);
      expect(new Set(c).size).toBe(c.length);
      expect(c.length).toBeGreaterThanOrEqual(4);
      expect(c.length).toBeLessThanOrEqual(6);
    }
    expect(new Set(stress.map((r) => complaints(r).length)).size).toBe(3);
    expect(new Set(stress.flatMap(complaints))).toEqual(new Set(stressPool));
  });
});
