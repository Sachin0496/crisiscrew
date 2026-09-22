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
import { runIncident } from "./agents/commander";
import { carryOutDecision } from "./agents/handoff";
import type { AgentKit } from "./agents/kit";
import { linkLateTicket } from "./agents/recovery";
import type { EventBus } from "./bus";
import { PatternEngine } from "./correlation/pattern";
import type { Prototypes } from "./correlation/prototypes";
import { AuditLog } from "./policy/audit";
import { PolicyGate } from "./policy/gate";
import type { Clock, Embedder, Ports } from "./ports";
import type { Draft } from "./recovery/templates";
import { createTools, type ToolCtx } from "./tools/definitions";

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
  onAudit?: (entry: AuditEntry) => void;
  onError?: (error: unknown) => void;
};

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * One incident-response session: the Pattern Agent's detection plus the four
 * agents behind the policy gate. All state comes from the events it emits, so
 * what the UI shows is exactly what the engine knows.
 */
export class CrisisEngine {
  readonly audit: AuditLog;
  readonly gate: PolicyGate<ToolCtx>;
  private view: CrisisState = initialState();
  private readonly pattern: PatternEngine;
  private readonly tasks = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly counters = { ticket: 1000, incident: 0, update: 0, approval: 0 };
  private readonly drafts = new Map<string, { draft: Draft; since: number }>();
  private readonly spentApprovals = new Set<string>();
  private readonly opened = new Map<string, Promise<void>>();
  private readonly kit: AgentKit;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {
    this.audit = new AuditLog((entry) => {
      deps.onAudit?.(entry);
      this.emit({ type: "tool.called", payload: { entry } });
    });
    const ctx: ToolCtx = {
      now: () => deps.clock.now(),
      state: () => this.view,
      ports: deps.ports,
      policy: deps.policy,
      emit: (e) => this.emit(e),
      drafts: this.drafts,
      nextId: (kind) => (kind === "update" ? `UPD-${pad(++this.counters.update)}` : `APR-${pad(++this.counters.approval)}`),
      spentApprovals: this.spentApprovals,
    };
    this.gate = new PolicyGate(deps.policy, createTools(), this.audit, deps.clock, () => ctx);
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
    };
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
    this.track(carryOutDecision(this.kit, decided));
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

  private async ingestNow(input: TicketInput, source: TicketSource): Promise<Ticket> {
    const ticket: Ticket = { ...input, id: `T-${++this.counters.ticket}`, source, receivedAt: input.receivedAt ?? this.deps.clock.now() };
    this.emit({ type: "ticket.received", payload: { ticket } });
    this.setAgent("pattern", "working", `Reading ${ticket.id}`);

    const result = await this.pattern.ingest(ticket);
    this.emit({ type: "signal.scored", payload: { signal: result.signal, nearest: result.nearest } });

    if (result.fires && result.candidate) {
      const incidentId = `INC-${new Date(this.deps.clock.now()).getUTCFullYear()}-${pad(++this.counters.incident)}`;
      const cluster = { ...result.candidate, incidentId };
      this.emit({ type: "cluster.updated", payload: { cluster } });
      this.pattern.attachIncident(incidentId, cluster.reportTicketIds);
      let markOpened!: () => void;
      this.opened.set(incidentId, new Promise((resolve) => (markOpened = resolve)));
      this.setAgent("pattern", "done", `${cluster.reportTicketIds.length} failure reports describe one problem; alerted the Incident Commander`);
      this.track(
        runIncident(this.kit, cluster, incidentId, (ref) => this.deps.ports.orders.customer(ref), markOpened).catch((error) => {
          markOpened();
          this.fail("commander", error);
        }),
      );
    } else if (result.joinIncidentId) {
      const incidentId = result.joinIncidentId;
      if (result.candidate) this.emit({ type: "cluster.updated", payload: { cluster: result.candidate } });
      this.setAgent("pattern", "done", `${ticket.id} matches ${incidentId}`);
      this.track(
        (async () => {
          await this.opened.get(incidentId);
          await linkLateTicket(this.kit, incidentId, ticket.id);
        })().catch((error) => this.fail("recovery", error)),
      );
    } else {
      if (result.candidate) this.emit({ type: "cluster.updated", payload: { cluster: result.candidate } });
      this.setAgent("pattern", "idle", `${ticket.id}: no incident`);
    }
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
