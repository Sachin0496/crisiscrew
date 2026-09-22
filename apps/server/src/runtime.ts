import { createSandboxPorts } from "@crisiscrew/adapters";
import type { Approval, AuditEntry, CrisisState, DecisionBody, Policy, Scenario, Ticket, TicketInput } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ScaledClock, SystemClock, type Clock, type EngineSession, type Embedder } from "@crisiscrew/core";
import { scenarioTickets } from "./scenarios";

export type RuntimeOptions = {
  policy: Policy;
  scenarios: Map<string, Scenario>;
  embedder: Embedder;
  /** Pause per sandbox call, in scenario milliseconds. */
  latencyMs: number;
  /** Scenario whose world backs the live session (for tickets typed into the UI). */
  liveWorld: string;
  /** Called for every audit entry, with the session it belongs to (each session is its own hash chain). */
  onAudit?: (entry: AuditEntry, sessionId: string) => void;
  onError?: (error: unknown) => void;
};

export type ScenarioSummary = Pick<Scenario, "id" | "title" | "purpose" | "speed" | "expected"> & { tickets: number };

/**
 * Owns the current session. A replay swaps in a fresh engine with the
 * scenario's sandbox world on a scaled clock; the event bus outlives
 * sessions, so the UI's stream never breaks.
 */
export class Runtime {
  readonly bus = new EventBus();
  private engine: CrisisEngine | null = null;
  private run = { cancelled: false };
  private sessions = 0;

  constructor(private readonly options: RuntimeOptions) {}

  async start(): Promise<void> {
    await this.startLive();
  }

  async startLive(): Promise<string> {
    const world = this.scenario(this.options.liveWorld);
    return this.swap(world, { mode: "live", scenarioId: world.id, scenarioTitle: world.title, speed: 1 }, new SystemClock(), Date.now());
  }

  async startReplay(id: string, speed?: number): Promise<string> {
    const scenario = this.scenario(id);
    const pace = speed ?? scenario.speed;
    const t0 = Date.now();
    const clock = new ScaledClock(t0, pace);
    const sessionId = await this.swap(scenario, { mode: "replay", scenarioId: id, scenarioTitle: scenario.title, speed: pace }, clock, t0);
    void this.play(scenario, this.engine!, clock, t0, this.run);
    return sessionId;
  }

  ingest(input: TicketInput): Promise<Ticket> {
    const { receivedAt: _ignored, ...rest } = input;
    return this.current().ingest(rest, "manual");
  }

  decide(approvalId: string, body: DecisionBody, by: string): Promise<Approval> {
    return this.current().decide(approvalId, body, by);
  }

  state(): CrisisState {
    return this.current().snapshot();
  }

  engineNow(): CrisisEngine {
    return this.current();
  }

  policy(): Policy {
    return this.options.policy;
  }

  scenarioList(): ScenarioSummary[] {
    return [...this.options.scenarios.values()].map((s) => ({
      id: s.id,
      title: s.title,
      purpose: s.purpose,
      speed: s.speed,
      expected: s.expected,
      tickets: s.tickets.length,
    }));
  }

  private scenario(id: string): Scenario {
    const scenario = this.options.scenarios.get(id);
    if (!scenario) throw new Error(`unknown scenario "${id}"`);
    return scenario;
  }

  private current(): CrisisEngine {
    if (!this.engine) throw new Error("the runtime has not started");
    return this.engine;
  }

  private async swap(scenario: Scenario, session: Omit<EngineSession, "sessionId">, clock: Clock, t0: number): Promise<string> {
    this.run.cancelled = true;
    this.engine?.stop();
    this.run = { cancelled: false };
    const sessionId = `S${++this.sessions}`;
    const engine = new CrisisEngine({
      ports: createSandboxPorts(scenario, { t0, clock, latencyMs: this.options.latencyMs }),
      embedder: this.options.embedder,
      clock,
      policy: this.options.policy,
      bus: this.bus,
      session: { sessionId, ...session },
      baselinePerHour: scenario.world.baselinePerHour,
      onAudit: this.options.onAudit ? (entry) => this.options.onAudit!(entry, sessionId) : undefined,
      onError: this.options.onError,
    });
    this.engine = engine;
    await engine.init();
    return sessionId;
  }

  private async play(scenario: Scenario, engine: CrisisEngine, clock: Clock, t0: number, token: { cancelled: boolean }): Promise<void> {
    try {
      for (const t of scenarioTickets(scenario, t0).sort((a, b) => a.receivedAt - b.receivedAt)) {
        const wait = t.receivedAt - clock.now();
        if (wait > 0) await clock.sleep(wait);
        if (token.cancelled) return;
        const { id: _id, source: _source, ...input } = t;
        await engine.ingest(input, "sandbox");
      }
      await engine.whenIdle();
      if (!token.cancelled) engine.finishReplay(scenario.id);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
