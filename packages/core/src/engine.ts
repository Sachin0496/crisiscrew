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
  type Alert,
  type AlertInput,
  type ImportanceAssessment,
  type ImportanceLevel,
  type IncidentStatus,
  type Policy,
  type SessionMode,
  type Surface,
  type Ticket,
  type TicketInput,
  type TicketSource,
} from "@crisiscrew/contracts";
import { handleLateTicket, onAlertLinked, runAlertIncident, runIncident, setImportanceByHuman, settleDecision } from "./agents/commander";
import { acknowledgeByOperator, onPageCall } from "./agents/paging";
import type { AgentKit } from "./agents/kit";
import type { EventBus } from "./bus";
import { PatternEngine } from "./correlation/pattern";
import { higher } from "./importance/assess";
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
  /** This server's public URL, for links back from engineering records. */
  publicBaseUrl?: string;
};

const pad = (n: number) => String(n).padStart(3, "0");

/**
 * One customer-harm-response session: the Pattern Agent's detection plus the
 * four agents behind the policy gate. All state comes from the events it
 * emits, so what the UI shows is exactly what the engine knows.
 */
export class CrisisEngine {
  readonly audit: AuditLog;
  readonly gate: PolicyGate<ToolCtx>;
  private view: CrisisState = initialState();
  private readonly pattern: PatternEngine;
  private readonly tasks = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly counters = { ticket: 1000, incident: 0, update: 0, approval: 0, action: 0, alert: 0 };
  private readonly drafts = new Map<string, { draft: Draft; since: number }>();
  private readonly spentApprovals = new Set<string>();
  private readonly opened = new Map<string, Promise<void>>();
  /** The tail of each incident's recovery chain: recovery steps for one incident run one at a time. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly kit: AgentKit;
  private stopped = false;
  private readonly unsubscribe: () => void;

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
      nextId: (kind) =>
        kind === "update" ? `UPD-${pad(++this.counters.update)}` : kind === "approval" ? `APR-${pad(++this.counters.approval)}` : `RA-${pad(++this.counters.action)}`,
      spentApprovals: this.spentApprovals,
      ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}),
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
      sleep: (ms) => deps.clock.sleep(ms),
      alive: () => !this.stopped,
      emit: (e) => this.emit(e),
      setAgent: (agent, status, task) => this.setAgent(agent, status, task),
      setStatus: (id, to, note) => this.setStatus(id, to, note),
      serial: (incidentId, run) => {
        const next = (this.chains.get(incidentId) ?? Promise.resolve()).then(run);
        this.chains.set(incidentId, next.catch(() => undefined));
        return next;
      },
      noted: new Set(),
    };
    this.unsubscribe = deps.ports.telephony.onUpdate((call) => {
      this.emit({ type: "call.updated", payload: { call } });
      if (call.purpose === "oncall" && call.metadata?.incidentId) this.track(onPageCall(this.kit, call).catch((error) => this.fail("commander", error)));
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
    this.unsubscribe();
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

  /**
   * Takes one operational alert, in arrival order with tickets. A repeat of
   * a known alert only updates whether it's resolved. Otherwise it's linked
   * to an open incident on its service's product area, or, when it's
   * critical and that area is tier 1, opens an incident of its own.
   * Anything else is recorded and nothing more.
   */
  ingestAlert(input: AlertInput & { resolvedAt?: number }): Promise<Alert> {
    const run = this.queue.then(() => this.ingestAlertNow(input));
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
    this.track(settleDecision(this.kit, decided).catch((error) => this.fail("handoff", error)));
    return decided;
  }

  /**
   * A human sets an incident's importance, up or down. The rules no longer
   * change it; the engineering record's priority follows. Resolves once
   * the record is updated.
   */
  async setImportance(incidentId: string, level: ImportanceLevel, by: string, note?: string): Promise<ImportanceAssessment> {
    const incident = this.view.incidents[incidentId];
    if (!incident) throw new Error(`no incident ${incidentId}`);
    const importance: ImportanceAssessment = {
      level,
      page: !higher(this.deps.policy.importance.pageAt, level),
      reasons: [{ rule: "human", level, text: `Set to ${level} by ${by}${note ? `: “${note}”` : ""}` }],
      stage: "human",
      source: "human",
      by,
      ...(note ? { note } : {}),
      assessedAt: this.deps.clock.now(),
    };
    const run = this.kit.serial(incidentId, () => setImportanceByHuman(this.kit, incidentId, importance));
    this.track(run);
    await run;
    return importance;
  }

  /** An operator acknowledges an incident's page, here or in Freshservice; no one else is called. */
  async acknowledgePage(incidentId: string, by: string): Promise<void> {
    if (!this.view.incidents[incidentId]) throw new Error(`no incident ${incidentId}`);
    const run = acknowledgeByOperator(this.kit, incidentId, by);
    this.track(run);
    await run;
  }

  /** Marks the end of a scenario replay (every ticket ingested and all agent work settled). */
  finishReplay(scenarioId: string): void {
    this.emit({ type: "replay.finished", payload: { scenarioId } });
  }

  /** Resolves when every ingest and agent task started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  private async ingestAlertNow(input: AlertInput & { resolvedAt?: number }): Promise<Alert> {
    const known = input.externalId ? Object.values(this.view.alerts).find((a) => a.source === input.source && a.externalId === input.externalId) : undefined;
    if (known) {
      if (input.resolvedAt !== undefined && known.resolvedAt === undefined) this.emit({ type: "alert.resolved", payload: { alertId: known.id, at: input.resolvedAt } });
      return this.view.alerts[known.id]!;
    }
    const { resolvedAt, ...fields } = input;
    const alert: Alert = { ...fields, id: `ALR-${pad(++this.counters.alert)}` };
    this.emit({ type: "alert.received", payload: { alert } });
    if (resolvedAt !== undefined) {
      this.emit({ type: "alert.resolved", payload: { alertId: alert.id, at: resolvedAt } });
      return this.view.alerts[alert.id]!;
    }

    const surfaces = this.surfacesOf(alert.service);
    const open = this.openIncidentFor(surfaces, alert.firedAt);
    if (open) {
      this.emit({ type: "alert.linked", payload: { alertId: alert.id, incidentId: open } });
      this.setAgent("commander", "working", `${alert.severity === "critical" ? "Critical" : "Warning"} alert on ${alert.service} linked to ${open}`);
      this.track(
        (async () => {
          await this.opened.get(open);
          await onAlertLinked(this.kit, open);
        })().catch((error) => this.fail("commander", error)),
      );
      return this.view.alerts[alert.id]!;
    }

    const tier1 = surfaces.find((s) => this.deps.policy.importance.tier1Surfaces.includes(s));
    if (alert.severity !== "critical" || !tier1 || !this.deps.policy.alerts.openOnCritical) {
      this.setAgent(
        "commander",
        "idle",
        `${alert.severity === "critical" ? "Critical" : "Warning"} alert on ${alert.service} recorded; ${alert.severity !== "critical" ? "a warning doesn't open an incident" : "its service isn't behind a tier-1 area"}`,
      );
      return alert;
    }
    const incidentId = this.nextIncidentId();
    let markOpened!: () => void;
    this.opened.set(incidentId, new Promise((resolve) => (markOpened = resolve)));
    this.track(
      runAlertIncident(this.kit, alert, tier1, incidentId, markOpened).catch((error) => {
        markOpened();
        this.fail("commander", error);
      }),
    );
    return alert;
  }

  /** The product areas a service is behind, per the service catalog. */
  private surfacesOf(service: string): Surface[] {
    const all: Surface[] = ["checkout_payments", "login_account", "delivery_orders", "refunds_billing", "app_performance", "other"];
    return all.filter((s) => this.deps.ports.catalog.servicesFor(s).some((info) => info.name === service));
  }

  /** The most recent incident still being worked on in one of these areas, opened within the join window before `at`. */
  private openIncidentFor(surfaces: Surface[], at: number): string | undefined {
    const window = this.deps.policy.alerts.joinWindowMin * 60_000;
    return [...this.view.incidentOrder]
      .reverse()
      .find((id) => {
        const i = this.view.incidents[id]!;
        return surfaces.includes(i.surface) && i.status !== "resolved" && i.status !== "dismissed" && at - i.openedAt <= window;
      });
  }

  private nextIncidentId(): string {
    return `INC-${new Date(this.deps.clock.now()).getUTCFullYear()}-${pad(++this.counters.incident)}`;
  }

  private async ingestNow(input: TicketInput, source: TicketSource): Promise<Ticket> {
    const ticket: Ticket = { ...input, id: `T-${++this.counters.ticket}`, source, receivedAt: input.receivedAt ?? this.deps.clock.now() };
    this.emit({ type: "ticket.received", payload: { ticket } });
    this.setAgent("pattern", "working", `Reading ${ticket.id}`);

    const result = await this.pattern.ingest(ticket);
    this.emit({ type: "signal.scored", payload: { signal: result.signal, nearest: result.nearest } });

    // An incident an alert opened, in this ticket's area: a failure report joins it, and a burst merges into it rather than opening a second one.
    const alertIncident = !result.joinIncidentId && result.signal.isFailure ? this.alertIncidentFor(result.candidate?.dominantSurface ?? result.signal.surface, ticket.receivedAt) : undefined;
    if (alertIncident) {
      const members = result.fires && result.candidate ? result.candidate.reportTicketIds : [ticket.id];
      this.pattern.joinIncident(alertIncident, members);
      this.setAgent("pattern", "done", `${members.length === 1 ? ticket.id : `${members.length} failure reports`} match ${alertIncident}, which an alert opened`);
      this.track(
        (async () => {
          await this.opened.get(alertIncident);
          for (const id of members) if (!this.linkedTo(alertIncident, id)) await handleLateTicket(this.kit, alertIncident, id);
        })().catch((error) => this.fail("recovery", error)),
      );
      return ticket;
    }

    if (result.fires && result.candidate) {
      const incidentId = this.nextIncidentId();
      const cluster = { ...result.candidate, incidentId };
      this.emit({ type: "cluster.updated", payload: { cluster } });
      this.pattern.attachIncident(incidentId, cluster.reportTicketIds);
      let markOpened!: () => void;
      this.opened.set(incidentId, new Promise((resolve) => (markOpened = resolve)));
      this.setAgent("pattern", "done", `${cluster.reportTicketIds.length} failure reports describe one problem; alerted the Incident Commander`);
      this.track(
        runIncident(this.kit, cluster, incidentId, markOpened).catch((error) => {
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
          await handleLateTicket(this.kit, incidentId, ticket.id);
        })().catch((error) => this.fail("recovery", error)),
      );
    } else {
      if (result.candidate) this.emit({ type: "cluster.updated", payload: { cluster: result.candidate } });
      this.setAgent("pattern", "idle", `${ticket.id}: no incident`);
    }
    return ticket;
  }

  /** An open incident an alert opened in this area, recent enough for complaints to belong to it. */
  private alertIncidentFor(surface: Surface, at: number): string | undefined {
    const id = this.openIncidentFor([surface], at);
    return id && this.view.incidents[id]?.trigger === "alert" ? id : undefined;
  }

  private linkedTo(incidentId: string, ticketId: string): boolean {
    const incident = this.view.incidents[incidentId];
    return Boolean(incident && (incident.ticketIds.includes(ticketId) || incident.linkedTicketIds.includes(ticketId)));
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
