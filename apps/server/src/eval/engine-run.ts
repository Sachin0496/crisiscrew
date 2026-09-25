import { createSandboxPorts } from "@crisiscrew/adapters";
import type { Channel, CrisisState, Policy, Scenario } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock, type Embedder, type PromptGuard, type TicketClassifier, type TraceSink } from "@crisiscrew/core";
import { scenarioTickets } from "../scenarios";

export const EVAL_T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

/** A ticket added to a scenario, `atMs` after its start: an attack, or a complaint the scenario doesn't have. */
export type ExtraTicket = { atMs: number; customerRef: string; customerName: string; body: string; channel?: Channel };

export type EngineRunOptions = {
  policy: Policy;
  embedder: Embedder;
  extra?: ExtraTicket[];
  /** After the tickets: approve every pending credit as asked, like an approver who agrees with the plan. */
  approveAll?: boolean;
  guard?: PromptGuard;
  classifier?: TicketClassifier | null;
  traceSinks?: TraceSink[];
};

/** Runs a scenario through the whole engine on a manual clock, ticket by ticket, and returns the engine and its final state. */
export async function runEngine(scenario: Scenario, options: EngineRunOptions): Promise<{ engine: CrisisEngine; state: CrisisState }> {
  const clock = new ManualClock(EVAL_T0);
  const engine = new CrisisEngine({
    ports: createSandboxPorts(scenario, { t0: EVAL_T0, clock, latencyMs: 0 }),
    embedder: options.embedder,
    clock,
    policy: options.policy,
    bus: new EventBus(),
    baselinePerHour: scenario.world.baselinePerHour,
    session: { sessionId: scenario.id, mode: "replay", scenarioId: scenario.id, speed: 1 },
    ...(options.guard ? { guard: options.guard } : {}),
    classifier: options.classifier ?? null,
    traceSinks: options.traceSinks ?? [],
  });
  await engine.init();
  const tickets = [
    ...scenarioTickets(scenario, EVAL_T0).map((t) => ({ at: t.receivedAt, customerRef: t.customerRef, customerName: t.customerName, body: t.body, channel: t.channel })),
    ...(options.extra ?? []).map((e) => ({ at: EVAL_T0 + e.atMs, customerRef: e.customerRef, customerName: e.customerName, body: e.body, channel: e.channel ?? ("chat" as Channel) })),
  ].sort((a, b) => a.at - b.at);
  for (const t of tickets) {
    clock.set(t.at);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.at });
    await engine.whenIdle();
  }
  if (options.approveAll) {
    for (const approval of Object.values(engine.snapshot().approvals).filter((a) => a.status === "pending")) {
      await engine.decide(approval.id, { decision: "approve" }, "eval approver");
      await engine.whenIdle();
    }
  }
  return { engine, state: engine.snapshot() };
}
