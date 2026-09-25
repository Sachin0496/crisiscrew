import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import type { Scenario } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);

async function run(scenario: Scenario) {
  const clock = new ManualClock(T0);
  const ports = createSandboxPorts(scenario, { t0: T0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports,
    embedder,
    clock,
    policy: loadPolicy(),
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: scenario.id, speed: 1 },
    publicBaseUrl: "https://crisis.example.com/",
  });
  await engine.init();
  for (const t of scenarioTickets(scenario, T0)) {
    clock.set(t.receivedAt);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.receivedAt });
    await engine.whenIdle();
  }
  await engine.whenIdle();
  const state = engine.snapshot();
  return { engine, ports, incident: state.incidents[state.incidentOrder[0]!]! };
}

describe("the Issue Creator", () => {
  it("files one engineering incident after the investigation, leading with the likely cause, the impact and links back", async () => {
    const { engine, ports, incident } = await run(scenarios.get("checkout-v4.21.7")!);
    expect(ports.record.incidents).toHaveLength(1);
    const record = ports.record.incidents[0]!;
    expect(record).toMatchObject({ importance: "P1", service: "checkout-service", tags: ["crisiscrew", "checkout_payments"] });
    expect(record.description).toContain("Likely cause: checkout-service v4.21.7 (97% confidence)");
    expect(record.description).toContain("Suspected change: checkout-service v4.21.7, commit 3f9c2e1 by vikram-s.");
    expect(record.description).toMatch(/Customer impact so far: 23 confirmed affected \(\d+ complained, \d+ silent\), ₹[\d,]+ in failed or pending payments\./);
    expect(record.description).toContain("Follow it in CrisisCrew: https://crisis.example.com/#/incident");
    // Filed by the Issue Creator, after every check the Investigator made.
    const entries = engine.audit.entries();
    const filed = entries.findIndex((e) => e.tool === "file_engineering_incident");
    expect(entries[filed]).toMatchObject({ identity: "issue_creator", decision: "allowed" });
    expect(Math.max(...entries.map((e, i) => (e.identity === "investigator" ? i : -1)))).toBeLessThan(filed);
    expect(incident.engineering).toMatchObject({ id: record.id, change: { id: "CHG-001" } });
  });

  it("requests a rollback change for the blamed release, for a human to plan, and never twice", async () => {
    const { engine, ports, incident } = await run(scenarios.get("checkout-v4.21.7")!);
    expect(ports.record.incidents[0]?.change).toMatchObject({ title: "Roll back checkout-service v4.21.7 (INC-2026-001)" });
    expect(ports.record.incidents[0]?.change?.description).toContain("CrisisCrew doesn't roll anything back.");
    expect(await engine.gate.call("issue_creator", "file_engineering_incident", { incidentId: incident.id })).toMatchObject({ ok: false, reason: "already filed as ENG-001" });
    expect(await engine.gate.call("issue_creator", "request_rollback_change", { incidentId: incident.id })).toMatchObject({ ok: false, reason: "already requested as CHG-001" });
  });

  it("asks for no rollback when the cause isn't a release, and records no refusal for it", async () => {
    const { engine, ports, incident } = await run(scenarios.get("upi-provider-outage")!);
    expect(ports.record.incidents[0]?.change).toBeUndefined();
    expect(engine.audit.entries().filter((e) => e.tool === "request_rollback_change")).toHaveLength(0);
    expect(await engine.gate.call("issue_creator", "request_rollback_change", { incidentId: incident.id })).toMatchObject({ ok: false, reason: "no release is the likely cause" });
    expect(ports.record.incidents[0]?.description).toContain("Likely cause: Razorpay payment gateway");
  });

  it("opens a problem record for the post-incident review once every customer is recovered, and only then", async () => {
    const { engine, ports, incident } = await run(scenarios.get("checkout-v4.21.7")!);
    expect(await engine.gate.call("issue_creator", "open_problem_record", { incidentId: incident.id })).toMatchObject({ ok: false, reason: "the incident isn't recovered yet" });
    for (const approval of Object.values(engine.snapshot().approvals)) await engine.decide(approval.id, { decision: "approve" }, "Asha");
    await engine.whenIdle();
    expect(engine.snapshot().incidents[incident.id]?.status).toBe("recovered");
    expect(ports.record.incidents[0]?.problem).toMatchObject({ id: "PRB-001", title: "Post-incident review: checkout and payment failures (INC-2026-001)" });
    expect(engine.snapshot().incidents[incident.id]?.engineering?.problem).toEqual({ id: "PRB-001" });
  });

  it("keeps filing to the Issue Creator: the Investigator can't write, and the Commander only updates", async () => {
    const { engine, incident } = await run(scenarios.get("checkout-v4.21.7")!);
    const id = incident.id;
    for (const tool of ["file_engineering_incident", "update_engineering_incident", "request_rollback_change", "open_problem_record"]) {
      expect(await engine.gate.call("investigator", tool, { incidentId: id, note: "x" }), tool).toMatchObject({ ok: false });
    }
    expect(await engine.gate.call("commander", "file_engineering_incident", { incidentId: id })).toMatchObject({ ok: false, reason: "Incident Commander is not allowed to call file_engineering_incident" });
    expect(await engine.gate.call("commander", "update_engineering_incident", { incidentId: id, note: "Rollback started" })).toMatchObject({ ok: true });
  });
});
