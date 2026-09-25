import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import { recoveryCoverage, type AlertInput, type Scenario } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioAlerts, scenarioTickets } from "./scenarios";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const scenarios = loadScenarios();
const T0 = Date.UTC(2026, 8, 25, 14, 12, 0);

/** Replays a scenario's tickets and alerts on one timeline, as the runtime does. */
async function run(scenario: Scenario, extraAlerts: AlertInput[] = []) {
  const clock = new ManualClock(T0);
  const ports = createSandboxPorts(scenario, { t0: T0, clock, latencyMs: 0 });
  const engine = new CrisisEngine({
    ports,
    embedder,
    clock,
    policy: loadPolicy(),
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: "test", mode: "replay", scenarioId: scenario.id, scenarioTitle: scenario.title, speed: 1 },
  });
  await engine.init();
  const timeline = [
    ...scenarioTickets(scenario, T0).map((t) => ({ at: t.receivedAt, ticket: t })),
    ...[...scenarioAlerts(scenario, T0), ...extraAlerts].map((a) => ({ at: a.firedAt, alert: a })),
  ].sort((a, b) => a.at - b.at);
  for (const item of timeline) {
    clock.set(item.at);
    if ("alert" in item) await engine.ingestAlert(item.alert);
    else await engine.ingest({ customerRef: item.ticket.customerRef, customerName: item.ticket.customerName, channel: item.ticket.channel, body: item.ticket.body, receivedAt: item.at });
    await engine.whenIdle();
  }
  await engine.whenIdle();
  const state = engine.snapshot();
  return { engine, ports, state, incidents: state.incidentOrder.map((i) => state.incidents[i]!) };
}

describe("an alert before any complaint", () => {
  it("opens the incident from the alert, then merges the complaints into it instead of opening a second", async () => {
    const scenario = scenarios.get("alert-before-complaints")!;
    const { incidents, state } = await run(scenario);
    expect(incidents).toHaveLength(scenario.expected.incidents!);
    const [incident] = incidents;
    expect(incident).toMatchObject({ trigger: "alert", ticketIds: [], surface: "checkout_payments" });
    expect(incident!.timeline[0]?.note).toBe("Critical alert on checkout-service: checkout-service 5xx rate 3.4% for 5 minutes (threshold 2%)");
    const alert = state.alerts[incident!.alertIds![0]!]!;
    expect(alert).toMatchObject({ source: "sandbox", externalId: "fs-alert-9101", severity: "critical", incidentId: incident!.id });
    // Every checkout failure report ends up linked to the one incident; the delivery complaint stays out of it.
    expect(incident!.linkedTicketIds).toHaveLength(scenario.expected.linkedTickets!);
    const failures = Object.values(state.tickets).filter((t) => t.signal?.isFailure);
    expect(failures.filter((t) => t.signal?.surface === "checkout_payments").every((t) => t.incidentId === incident!.id)).toBe(true);
    expect(failures.filter((t) => t.signal?.surface !== "checkout_payments").map((t) => t.incidentId)).toEqual([undefined]);
  });

  it("finds the same harm as the complaint-led hero, silent customers included, and pages on-call at once", async () => {
    const scenario = scenarios.get("alert-before-complaints")!;
    const { incidents, engine } = await run(scenario);
    const incident = incidents[0]!;
    expect(incident.rootCause?.hypothesisId).toBe(scenario.expected.rootCause);
    expect(recoveryCoverage(incident)).toMatchObject({ confirmed: scenario.expected.affected, complained: 8, silent: scenario.expected.silent });
    expect(incident.importance).toMatchObject({ level: "P1", page: true });
    expect(incident.importance!.reasons[0]?.text).toBe("Critical alert on checkout-service: checkout-service 5xx rate 3.4% for 5 minutes (threshold 2%)");
    expect(incident.paging).toMatchObject({ status: "acknowledged", acknowledgedBy: "Neha Kapoor" });
    // The page went out before the Investigator finished: right after the incident opened.
    const calls = engine.audit.entries().map((e) => e.tool);
    expect(calls.indexOf("page_on_call")).toBeLessThan(calls.indexOf("get_payment_health"));
    // The release's evidence includes its own alert, and the timing is counted from the alert.
    const cause = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId)!;
    expect(cause.evidence.map((e) => e.observation)).toContain("critical alert on checkout-service 14 min after the release: checkout-service 5xx rate 3.4% for 5 minutes (threshold 2%)");
    expect(cause.evidence[0]?.observation).toMatch(/^released \d+ min before the first alert/);
  });
});

describe("an alert during a complaint incident", () => {
  it("links to the open incident, adds evidence and raises the importance, without opening another", async () => {
    const hero = scenarios.get("checkout-v4.21.7")!;
    const late: AlertInput = {
      source: "freshservice",
      externalId: "4242",
      service: "checkout-service",
      metric: "http_5xx_rate",
      severity: "critical",
      label: "checkout-service 5xx rate above 2%",
      firedAt: T0 + 100_000,
    };
    const { incidents, state } = await run(hero, [late]);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!;
    expect(incident.trigger).toBe("complaints");
    expect(incident.alertIds).toHaveLength(1);
    expect(state.alerts[incident.alertIds![0]!]?.incidentId).toBe(incident.id);
    const cause = incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId)!;
    expect(cause.evidence.some((e) => e.source === "alerts")).toBe(true);
    expect(incident.importance?.reasons.map((r) => r.rule)).toContain("alert");
    // Re-ranking the cause didn't move the incident back to "root cause identified".
    expect(incident.status).toBe("awaiting_approval");
    expect(recoveryCoverage(incident)).toMatchObject({ confirmed: 23, recovered: 21 });
  });

  it("records a repeat of the same alert once, and its resolution", async () => {
    const hero = scenarios.get("checkout-v4.21.7")!;
    const alert: AlertInput = { source: "freshservice", externalId: "77", service: "checkout-service", metric: "cpu", severity: "warning", label: "CPU high", firedAt: T0 + 90_000 };
    const { engine } = await run(hero, [alert]);
    await engine.ingestAlert({ ...alert, firedAt: T0 + 95_000 });
    await engine.ingestAlert({ ...alert, resolvedAt: T0 + 200_000 });
    const alerts = Object.values(engine.snapshot().alerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ resolvedAt: T0 + 200_000 });
  });
});

describe("restraint with alerts", () => {
  it("records a warning and a critical alert off the tier-1 areas, and opens no incident", async () => {
    const scenario = scenarios.get("noisy-alert")!;
    const { incidents, state, engine } = await run(scenario);
    expect(incidents).toHaveLength(0);
    expect(Object.values(state.alerts).map((a) => `${a.service}:${a.severity}`)).toEqual(["checkout-service:warning", "search-service:critical"]);
    expect(Object.values(state.alerts).every((a) => a.incidentId === undefined)).toBe(true);
    expect(engine.audit.entries().filter((e) => e.tool === "page_on_call")).toHaveLength(0);
  });
});
