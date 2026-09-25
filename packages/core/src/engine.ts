import {
  AGENT_IDS,
  initialState,
  reduce,
  type AgentId,
  type AgentStatus,
  type Approval,
  type AuditEntry,
  type CrisisState,
  type DecisionBody,
  type EventInput,
  type IncidentStatus,
  type Policy,
  type SessionMode,
  type Surface,
  type Ticket,
  type TicketInput,
  type TicketSource,
} from "@crisiscrew/contracts";
import type { AgentKit } from "./agents/kit";
import type { EventBus } from "./bus";
import { PatternEngine } from "./correlation/pattern";
import type { Prototypes } from "./correlation/prototypes";
import { heuristicGuard } from "./guard/builtin";
import { AuditLog } from "./policy/audit";
import { PolicyGate } from "./policy/gate";
import type { Clock, Embedder, Ports, PromptGuard, TicketClassifier } from "./ports";
import type { Draft } from "./recovery/templates";
import { createTools, type ToolCtx } from "./tools/definitions";
import { Tracer, type TraceSink } from "./trace/tracer";
import { createWorkflows, type Workflows } from "./workflows/graphs";

export type EngineSession = { sessionId: string; mode: SessionMode; scenarioId?: string; scenarioTitle?: string; speed?: number };

export type EngineDeps = {
  ports: Ports;
  embedder: Embedder;
  clock: Clock;
  policy: Policy;
  bus: EventBus;
  session: EngineSession;
  baselinePerHour?: Partial<Record<Surface, number>>;
  prototypes?: Prototypes;
  /** Screens untrusted text. Defaults to the built-in rule-based guard. */
  guard?: PromptGuard;
  /** A decision model (Laya) for ticket type and product area. Absent: the built-in embedding classifier. */
  classifier?: TicketClassifier | null;
  /** Where workflow traces go besides the event stream: the Traces page's store, LangSmith. */
  traceSinks?: TraceSink[];
  onAudit?: (entry: AuditEntry) => void;
  onError?: (error: unknown) => void;
};

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * One customer-harm-response session: the Pattern Agent's detection plus the
 * four agents behind the policy gate, orchestrated as LangGraph workflows
 * and traced span by span. All state comes from the events it emits, so
 * what the UI shows is exactly what the engine knows.
 */
export class CrisisEngine {
  readonly audit: AuditLog;
  readonly gate: PolicyGate<ToolCtx>;
  readonly tracer: Tracer;
  private view: CrisisState = initialState();
  private readonly pattern: PatternEngine;
  private readonly tasks = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly counters = { ticket: 1000, incident: 0, update: 0, approval: 0, action: 0 };
  private readonly drafts = new Map<string, { draft: Draft; since: number }>();
  private readonly spentApprovals = new Set<string>();
  /** Incidents being opened: a ticket that joins one waits until it exists. */
  private readonly opened = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** The tail of each incident's recovery chain: recovery steps for one incident run one at a time. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly kit: AgentKit;
  private readonly flows: Workflows;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {
    this.audit = new AuditLog((entry) => {
      deps.onAudit?.(entry);
      this.emit({ type: "tool.called", payload: { entry } });
    });
    this.tracer = new Tracer({
      sessionId: deps.session.sessionId,
      now: () => deps.clock.now(),
      sinks: [{ traceChanged: (trace) => this.emit({ type: "trace.updated", payload: { trace } }) }, ...(deps.traceSinks ?? [])],
    });
    const guard = deps.guard ?? heuristicGuard;
    const ctx: ToolCtx = {
      now: () => deps.clock.now(),
      state: () => this.view,
      ports: deps.ports,
      policy: deps.policy,
      emit: (e) => this.emit(e),
      drafts: this.drafts,
      nextId: (kind) =>
        kind === "update" ? `UPD-${pad(++this.counters.update)}` : kind === "approval" ? `APR-${pad(++this.counters.approval)}` : `RA-${pad(++this.counters.action)}`,
      spentApprovals: this.spentApprovals,
    };
    this.gate = new PolicyGate(deps.policy, createTools(), this.audit, deps.clock, () => ctx, {
      tracer: this.tracer,
      guard,
      onFlag: (flag) => this.emit({ type: "guard.flagged", payload: { flag } }),
    });
    this.pattern = new PatternEngine(deps.embedder, deps.policy.correlation, {
      baselinePerHour: deps.baselinePerHour,
      prototypes: deps.prototypes,
    });
    this.kit = {
      gate: this.gate,
      state: () => this.view,
      draftFor: (id) => this.drafts.get(id)?.draft,
      policy: deps.policy,
      ports: deps.ports,
      now: () => deps.clock.now(),
      emit: (e) => this.emit(e),
      setAgent: (agent, status, task) => this.setAgent(agent, status, task),
      setStatus: (id, to, note) => this.setStatus(id, to, note),
      serial: (incidentId, run) => {
        const next = (this.chains.get(incidentId) ?? Promise.resolve()).then(run);
        this.chains.set(incidentId, next.catch(() => undefined));
        return next;
      },
      noted: new Set(),
      tracer: this.tracer,
    };
    this.flows = createWorkflows({
      kit: this.kit,
      pattern: this.pattern,
      guard,
      classifier: deps.classifier ?? null,
      nextIncidentId: () => `INC-${new Date(this.deps.clock.now()).getUTCFullYear()}-${pad(++this.counters.incident)}`,
      opening: (incidentId) => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        this.opened.set(incidentId, { promise, resolve });
      },
      markOpened: (incidentId) => this.opened.get(incidentId)?.resolve(),
      whenOpened: (incidentId) => this.opened.get(incidentId)?.promise ?? Promise.resolve(),
      track: (promise) => this.track(promise),
      fail: (agent, error) => this.fail(agent, error),
    });
  }

  async init(): Promise<void> {
    await this.pattern.init();
    const agents = AGENT_IDS.map((id) => ({ id, name: this.deps.policy.identities[id].name, level: this.deps.policy.identities[id].maxLevel }));
    this.emit({ type: "session.started", payload: { ...this.deps.session, agents } });
  }

  /** Stops emitting; used when a new session replaces this one. */
  stop(): void {
    this.stopped = true;
  }

  snapshot(): CrisisState {
    return this.view;
  }

  /** Ingests tickets one at a time, in arrival order. Resolves once the ticket is scored, not when its incident work finishes. */
  ingest(input: TicketInput, source: TicketSource = "sandbox"): Promise<Ticket> {
    const run = this.queue.then(() => this.ingestNow(input, source));
    this.queue = run.catch(() => undefined);
    this.track(run);
    return run;
  }

  async decide(approvalId: string, body: DecisionBody, by: string): Promise<Approval> {
    const approval = this.view.approvals[approvalId];
    if (!approval) throw new Error(`no approval ${approvalId}`);
    if (approval.status !== "pending") throw new Error(`approval ${approvalId} is already ${approval.status}`);
    const status = body.decision === "approve" ? "approved" : body.decision === "modify" ? "modified" : "rejected";
    const decided: Approval = {
      ...approval,
      status,
      decidedBy: by,
      decidedAt: this.deps.clock.now(),
      ...(body.note ? { note: body.note } : {}),
      ...(status === "approved" ? { approvedAmountInr: approval.amountInr } : {}),
      ...(status === "modified" ? { approvedAmountInr: body.amountInr! } : {}),
    };
    this.emit({ type: "approval.decided", payload: { approval: decided } });
    this.track(this.flows.runDecision(decided).catch((error) => this.fail("handoff", error)));
    return decided;
  }

  /** Marks the end of a scenario replay (every ticket ingested and all agent work settled). */
  finishReplay(scenarioId: string): void {
    this.emit({ type: "replay.finished", payload: { scenarioId } });
  }

  /** Resolves when every ingest and agent task started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  /** Records the ticket, then runs the ticket workflow: screen, classify, correlate, and open, join or refuse. */
  private async ingestNow(input: TicketInput, source: TicketSource): Promise<Ticket> {
    const ticket: Ticket = { ...input, id: `T-${++this.counters.ticket}`, source, receivedAt: input.receivedAt ?? this.deps.clock.now() };
    this.emit({ type: "ticket.received", payload: { ticket } });
    this.setAgent("pattern", "working", `Reading ${ticket.id}`);
    await this.flows.runTicket(ticket);
    return ticket;
  }

  private emit(input: EventInput): void {
    if (this.stopped) return;
    const event = this.deps.bus.emit(input, this.deps.clock.now());
    this.view = reduce(this.view, event);
  }

  private setAgent(agent: AgentId, status: AgentStatus, task?: string): void {
    this.emit({ type: "agent.status", payload: { agent, status, ...(task ? { task } : {}) } });
  }

  private setStatus(incidentId: string, to: IncidentStatus, note: string): void {
    const incident = this.view.incidents[incidentId];
    if (!incident) return;
    this.emit({ type: "incident.status_changed", payload: { incidentId, from: incident.status, to, note } });
  }

  private fail(agent: AgentId, error: unknown): void {
    this.setAgent(agent, "done", `Stopped: ${error instanceof Error ? error.message : String(error)}`);
    this.deps.onError?.(error);
  }

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    this.tasks.add(tracked);
    void tracked.then(() => this.tasks.delete(tracked));
  }
}
