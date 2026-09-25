import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import { recoveryCoverage, type Scenario } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock, type InfraHealthPort } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);

async function run(scenario: Scenario, infra?: InfraHealthPort) {
  const clock = new ManualClock(T0);
  const sandbox = createSandboxPorts(scenario, { t0: T0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports: { ...sandbox, ...(infra ? { infra } : {}) },
    embedder,
    clock,
    policy: loadPolicy(),
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: scenario.id, scenarioTitle: scenario.title, speed: 1 },
  });
  await engine.init();
  for (const t of scenarioTickets(scenario, T0)) {
    clock.set(t.receivedAt);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.receivedAt });
    await engine.whenIdle();
  }
  await engine.whenIdle();
  const state = engine.snapshot();
  return { engine, incident: state.incidents[state.incidentOrder[0]!]! };
}

describe("infrastructure as a root cause", () => {
  it("blames crash-looping pods, not the old release or the gateway, with each factor shown", async () => {
    const scenario = scenarios.get("pods-crashloop")!;
    const { incident } = await run(scenario);
    expect(incident.rootCause).toMatchObject({ hypothesisId: scenario.expected.rootCause, label: "checkout-service infrastructure" });
    expect(incident.rootCause!.confidence).toBeGreaterThan(0.9);
    const infra = incident.hypotheses[0]!;
    expect(infra.evidence.map((e) => [e.observation, e.lr, e.adapter])).toEqual([
      ["checkout-service: 3 pods in CrashLoopBackOff (1/4 pods ready, 37 restarts)", 8, "sandbox"],
      ["cloud alarm on checkout-service: checkout-service-memory-high", 4, "sandbox"],
    ]);
    // The incident window opens at the alarm, and the harm is proved as before.
    expect(recoveryCoverage(incident)).toMatchObject({ confirmed: scenario.expected.affected, silent: scenario.expected.silent });
    // Customers hear it's our systems, not a release.
    expect(incident.updates.find((u) => u.channel === "proactive_message")?.text).toContain("a problem with our own systems");
  });

  it("keeps the hero's release first, with healthy pods counting against an infrastructure cause", async () => {
    const { incident } = await run(scenarios.get("checkout-v4.21.7")!);
    expect(incident.rootCause?.hypothesisId).toBe("deploy:checkout-service@4.21.7");
    expect(incident.rootCause!.confidence).toBeGreaterThan(0.95);
    const infra = incident.hypotheses.find((h) => h.kind === "infra")!;
    expect(infra.evidence.map((e) => e.lr)).toEqual([0.3, 0.6]);
  });

  it("shows an unreachable source as not checked, and never crashes or invents a value", async () => {
    const down: InfraHealthPort = {
      mode: "live",
      adapter: "mcp:k8s-prod",
      async health(service) {
        return { service, checks: [{ source: "mcp:k8s-prod", kind: "pods", checked: false, detail: "k8s-prod unreachable: connection refused" }] };
      },
    };
    const { incident, engine } = await run(scenarios.get("checkout-v4.21.7")!, down);
    const infra = incident.hypotheses.find((h) => h.kind === "infra")!;
    expect(infra.evidence).toEqual([
      { source: "get_infra_health", observation: "checkout-service pods not checked: k8s-prod unreachable: connection refused", lr: 1, adapter: "mcp:k8s-prod", checked: false },
      { source: "get_infra_health", observation: "cloud alarms not checked", lr: 1, adapter: "mcp:k8s-prod", checked: false },
    ]);
    expect(incident.rootCause?.hypothesisId).toBe("deploy:checkout-service@4.21.7");
    expect(engine.audit.entries().find((e) => e.tool === "get_infra_health")).toMatchObject({ identity: "investigator", adapter: "mcp:k8s-prod", decision: "allowed" });

    const failing: InfraHealthPort = { mode: "live", adapter: "mcp:k8s-prod", health: () => Promise.reject(new Error("boom")) };
    const broken = await run(scenarios.get("checkout-v4.21.7")!, failing);
    expect(broken.incident.hypotheses.find((h) => h.kind === "infra")).toMatchObject({ id: "infra:unverified", evidence: [{ observation: "infrastructure not checked", checked: false }] });
  });
});
