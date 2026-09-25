import {
  createSandboxPorts,
  freshdeskTicketActions,
  freshdeskToTicketInput,
  type FreshdeskClient,
  type FreshdeskTicket,
  type FreshdeskWriter,
  type VobizTelephony,
} from "@crisiscrew/adapters";
import type { Approval, AuditEntry, CrisisState, Customer, DecisionBody, Policy, Scenario, Ticket, TicketInput } from "@crisiscrew/contracts";
import {
  CrisisEngine,
  EventBus,
  ScaledClock,
  SystemClock,
  type Clock,
  type EngineSession,
  type Embedder,
  type CallRequest,
  type IncidentsPort,
  type Ports,
} from "@crisiscrew/core";
import { scenarioTickets } from "./scenarios";

/** Live Freshworks adapters, layered over the sandbox world when their switches are on. */
export type LiveAdapters = {
  /** TICKETS=freshdesk: reads Freshdesk tickets, and writes notes and replies for them. */
  freshdesk?: { client: FreshdeskClient; writer: FreshdeskWriter };
  /** INCIDENTS=freshservice: files engineering incidents in Freshservice. */
  incidents?: IncidentsPort;
  /** TELEPHONY=vobiz: places real phone calls. */
  telephony?: VobizTelephony;
};

export type RuntimeOptions = {
  policy: Policy;
  scenarios: Map<string, Scenario>;
  embedder: Embedder;
  /** Pause per sandbox call, in scenario milliseconds. */
  latencyMs: number;
  /** Scenario whose world backs the live session (for tickets typed into the UI or arriving from Freshdesk). */
  liveWorld: string;
  live?: LiveAdapters;
  /** Called for every audit entry, with the session it belongs to (each session is its own hash chain). */
  onAudit?: (entry: AuditEntry, sessionId: string) => void;
  onError?: (error: unknown) => void;
};

export type ScenarioSummary = Pick<Scenario, "id" | "title" | "purpose" | "speed" | "expected"> & { tickets: number };

export type DirectoryEntry = Pick<Customer, "ref" | "name" | "email" | "tier">;

/**
 * A live session's world is anchored this far in the past, so every payment
 * in its timeline has already happened when someone types or files a
 * complaint: the evidence is there to be found, as it would be in production.
 */
export const LIVE_WORLD_LEAD_MS = 2 * 60_000;

export type FreshdeskIngest =
  | { status: "ingested"; ticket: Ticket; matched: boolean }
  | { status: "duplicate" | "too_old" | "empty"; freshdeskId: number };

/**
 * Owns the current session. A replay swaps in a fresh engine with the
 * scenario's sandbox world on a scaled clock; the event bus outlives
 * sessions, so the UI's stream never breaks.
 */
export class Runtime {
  readonly bus = new EventBus();
  private engine: CrisisEngine | null = null;
  private ports: Ports | null = null;
  private world: Scenario | null = null;
  private startedAt = 0;
  private run = { cancelled: false };
  private sessions = 0;
  /** Freshdesk tickets already ingested in this session, so a retried webhook or an overlapping poll is ignored. */
  private seenExternal = new Set<string>();
  private lastPoll: Date | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  async start(): Promise<void> {
    await this.startLive();
  }

  async startLive(): Promise<string> {
    const world = this.scenario(this.options.liveWorld);
    return this.swap(world, { mode: "live", scenarioId: world.id, scenarioTitle: world.title, speed: 1 }, new SystemClock(), Date.now() - LIVE_WORLD_LEAD_MS);
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

  /** A customer of the current world, by email or exact name: how a typed or Freshdesk complaint is tied to payment evidence. */
  async findCustomer(query: { email?: string; name?: string }): Promise<Customer | null> {
    return this.currentPorts().orders.findCustomer(query);
  }

  /** The current world's customers, for the ticket box's suggestions. */
  customerDirectory(): DirectoryEntry[] {
    return (this.world?.world.customers ?? []).map((c) => ({ ref: c.ref, name: c.name, ...(c.email ? { email: c.email } : {}), tier: c.tier }));
  }

  get freshdeskEnabled(): boolean {
    return Boolean(this.options.live?.freshdesk);
  }

  /** Fetches a Freshdesk ticket named by the webhook and ingests it once. */
  async ingestFreshdesk(freshdeskId: number): Promise<FreshdeskIngest> {
    const freshdesk = this.options.live?.freshdesk;
    if (!freshdesk) throw new Error("Freshdesk ingest is off: set TICKETS=freshdesk");
    const key = `freshdesk:${freshdeskId}`;
    if (this.seenExternal.has(key)) return { status: "duplicate", freshdeskId };
    this.seenExternal.add(key);
    try {
      return await this.ingestFreshdeskTicket(await freshdesk.client.ticket(freshdeskId));
    } catch (error) {
      this.seenExternal.delete(key);
      throw error;
    }
  }

  /**
   * The poll fallback: ingests Freshdesk tickets created since the session
   * started that haven't been seen yet. Returns how many were ingested.
   */
  async pollFreshdesk(): Promise<number> {
    const freshdesk = this.options.live?.freshdesk;
    if (!freshdesk) return 0;
    const since = this.lastPoll ?? new Date(this.startedAt);
    const polledAt = new Date();
    const tickets = await freshdesk.client.ticketsUpdatedSince(since);
    let ingested = 0;
    for (const t of tickets) {
      const key = `freshdesk:${t.id}`;
      if (this.seenExternal.has(key) || Date.parse(t.created_at) < this.startedAt) continue;
      this.seenExternal.add(key);
      if ((await this.ingestFreshdeskTicket(t)).status === "ingested") ingested += 1;
    }
    this.lastPoll = polledAt;
    return ingested;
  }

  /** The live Vobiz adapter, for its callbacks; null when calls are simulated. */
  get vobiz(): VobizTelephony | null {
    return this.options.live?.telephony ?? null;
  }

  /** Places a call through the current session's telephony port (Vobiz or the sandbox). */
  placeCall(request: CallRequest): Promise<{ callId: string }> {
    return this.currentPorts().telephony.call(request);
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

  private async ingestFreshdeskTicket(t: FreshdeskTicket): Promise<FreshdeskIngest> {
    // Anything older than the correlation window can't change detection, so a late webhook for an old ticket is ignored.
    if (Date.parse(t.created_at) < this.startedAt - this.options.policy.correlation.windowMin * 60_000) return { status: "too_old", freshdeskId: t.id };
    const email = t.requester?.email ?? undefined;
    const customer = email ? await this.currentPorts().orders.findCustomer({ email }) : null;
    const input = freshdeskToTicketInput(t, customer);
    if (!input) return { status: "empty", freshdeskId: t.id };
    const ticket = await this.current().ingest(input, "freshdesk");
    return { status: "ingested", ticket, matched: customer !== null };
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

  private currentPorts(): Ports {
    if (!this.ports) throw new Error("the runtime has not started");
    return this.ports;
  }

  /** The scenario's sandbox world, with the live Freshworks adapters layered on top when they're switched on. */
  private portsFor(scenario: Scenario, clock: Clock, t0: number): Ports {
    const sandbox = createSandboxPorts(scenario, { t0, clock, latencyMs: this.options.latencyMs });
    const live = this.options.live;
    return {
      ...sandbox,
      ...(live?.freshdesk ? { ticketActions: freshdeskTicketActions(live.freshdesk.writer, sandbox.ticketActions) } : {}),
      ...(live?.incidents ? { incidents: live.incidents } : {}),
      ...(live?.telephony ? { telephony: live.telephony } : {}),
    };
  }

  private async swap(scenario: Scenario, session: Omit<EngineSession, "sessionId">, clock: Clock, t0: number): Promise<string> {
    this.run.cancelled = true;
    this.engine?.stop();
    this.run = { cancelled: false };
    this.seenExternal = new Set();
    this.lastPoll = null;
    this.startedAt = Date.now();
    const sessionId = `S${++this.sessions}`;
    const ports = this.portsFor(scenario, clock, t0);
    const engine = new CrisisEngine({
      ports,
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
    this.ports = ports;
    this.world = scenario;
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
